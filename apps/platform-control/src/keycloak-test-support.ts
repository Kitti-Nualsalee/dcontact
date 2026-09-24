/**
 * Test support ของ real-boundary test A1.4 (#409) เท่านั้น — production path ไม่ import ไฟล์นี้
 *
 * Keycloak (`pnpm infra:up` + `pnpm infra:identity:platform`) และ mailpit ต้องรันอยู่
 * ทุก resource ที่เทสต์สร้างถูกลบตาม `tenant_id` attribute ตอน dispose
 */
import { totp } from '../../../scripts/keycloak-platform-login.mjs';
import { KeycloakAdminClient } from './keycloak-admin.js';

export const KEYCLOAK_URL = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
export const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';
export const REALM = 'dcontact';

export function provisionerClient(fetcher?: typeof fetch) {
  return new KeycloakAdminClient({
    baseUrl: KEYCLOAK_URL,
    realm: REALM,
    clientId: 'dcontact-provisioner',
    clientSecret: process.env.KEYCLOAK_PROVISIONER_SECRET ?? 'dcontact-provisioner-dev-secret',
    ...(fetcher ? { fetch: fetcher } : {}),
  });
}

async function masterToken() {
  const response = await fetch(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? 'admin',
      password: process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? 'admin',
    }),
  });
  return ((await response.json()) as { access_token: string }).access_token;
}

/** Admin API ในนามผู้ดูแล realm — ใช้จัดฉาก/ตรวจ/cleanup เท่านั้น ไม่ใช่สิทธิ์ของ worker */
export async function keycloakAdmin<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${KEYCLOAK_URL}/admin/realms/${REALM}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await masterToken()}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}

export async function cleanupKeycloak(tenantIds: string[]) {
  for (const tenantId of tenantIds) {
    for (const kind of ['organizations', 'users'] as const) {
      const { body } = await keycloakAdmin<{ id: string }[]>(
        'GET',
        `/${kind}?${new URLSearchParams({ q: `tenant_id:${tenantId}`, max: '50' })}`,
      );
      for (const resource of body ?? []) {
        await keycloakAdmin('DELETE', `/${kind}/${resource.id}`);
      }
    }
  }
}

// ── mailpit ─────────────────────────────────────────────────────────────────

interface MailpitMessage {
  ID: string;
  Created: string;
  To: { Address: string }[];
}

export async function messagesTo(recipient: string): Promise<MailpitMessage[]> {
  const response = await fetch(
    `${MAILPIT_URL}/api/v1/search?${new URLSearchParams({ query: `to:"${recipient}"`, limit: '50' })}`,
  );
  const body = (await response.json()) as { messages?: MailpitMessage[] };
  return (body.messages ?? []).sort((left, right) => left.Created.localeCompare(right.Created));
}

/** ลิงก์ execute-actions ของทุกฉบับที่ส่งถึงผู้รับ เรียงเก่า → ใหม่ */
export async function invitationLinks(recipient: string): Promise<string[]> {
  const links: string[] = [];
  for (const message of await messagesTo(recipient)) {
    const full = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${message.ID}`)).json()) as {
      Text: string;
    };
    const link = full.Text.match(/https?:\/\/\S+action-token\S+/)?.[0];
    if (link) links.push(link);
  }
  return links;
}

export function actionTokenClaims(link: string) {
  const key = new URL(link).searchParams.get('key')!;
  return JSON.parse(Buffer.from(key.split('.')[1]!, 'base64url').toString()) as {
    iat: number;
    exp: number;
    typ: string;
    rqac: string[];
  };
}

// ── browser flow ────────────────────────────────────────────────────────────

const title = (html: string) =>
  (html.match(/<h1[^>]*id="kc-page-title"[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const formAction = (html: string) =>
  html.match(/<form[^>]*action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
const hidden = (html: string, name: string) =>
  html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`))?.[1] ??
  html.match(new RegExp(`value="([^"]*)"[^>]*name="${name}"`))?.[1];

/** เปิดลิงก์ invitation แล้วทำ required actions ตามหน้าที่ Keycloak แสดง แบบที่ browser ทำ */
export async function completeInvitation(link: string, password: string) {
  const cookies = new Map<string, string>();
  const go = async (url: string, init: RequestInit = {}) => {
    let current = url;
    let response = await fetch(current, {
      ...init,
      redirect: 'manual',
      headers: { ...(init.headers as Record<string, string>), cookie: jar() },
    });
    remember(response);
    for (let hop = 0; response.status >= 300 && response.status < 400 && hop < 10; hop += 1) {
      current = new URL(response.headers.get('location')!, current).href;
      response = await fetch(current, { redirect: 'manual', headers: { cookie: jar() } });
      remember(response);
    }
    return { status: response.status, url: current, html: await response.text() };
  };
  function remember(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair!.indexOf('=');
      cookies.set(pair!.slice(0, index), pair!.slice(index + 1));
    }
  }
  function jar() {
    return [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  }
  const post = (html: string, fields: Record<string, string>) =>
    go(formAction(html)!, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });

  let page = await go(link);
  let totpSecret: string | undefined;
  const pages: string[] = [];
  for (let step = 0; step < 8 && page.html; step += 1) {
    pages.push(title(page.html));
    const proceed = page.html
      .match(/href="([^"]*action-token[^"]*)"/)?.[1]
      ?.replaceAll('&amp;', '&');
    if (proceed && !formAction(page.html)) {
      page = await go(new URL(proceed, page.url).href);
    } else if (/password-new/.test(page.html)) {
      page = await post(page.html, { 'password-new': password, 'password-confirm': password });
    } else if (/totpSecret/.test(page.html)) {
      totpSecret = hidden(page.html, 'totpSecret')!;
      page = await post(page.html, { totp: totp(totpSecret), totpSecret, userLabel: 'boundary' });
    } else {
      break;
    }
  }
  return { status: page.status, pages, totpSecret };
}

/** tenant login ผ่าน client ของ dev readiness (password + OTP) — คืน access token */
export async function tenantLogin(input: {
  username: string;
  password: string;
  totpSecret: string;
}) {
  // รหัส OTP เดิมใช้ซ้ำใน window เดียวกันไม่ได้ (replay protection ของ Keycloak)
  const window = Math.floor(Date.now() / 30_000);
  await new Promise((resolve) => setTimeout(resolve, (window + 1) * 30_000 - Date.now() + 250));
  const response = await fetch(`${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'dcontact-dev-readiness',
      username: input.username,
      password: input.password,
      totp: totp(input.totpSecret),
      scope: 'openid organization',
    }),
  });
  const body = (await response.json()) as { access_token?: string; error?: string };
  return { status: response.status, accessToken: body.access_token, error: body.error };
}

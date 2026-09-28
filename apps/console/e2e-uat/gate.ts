import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * U1.7 (#435): helper ของ acceptance gate — state มาจาก runner (`scripts/u1-acceptance.mjs`) ผ่านไฟล์
 * ชั่วคราวที่ runner ลบเองเมื่อจบ; รหัสผ่าน/TOTP secret/token อยู่ในหน่วยความจำเท่านั้น ไม่ถูกเขียนเป็นหลักฐาน
 */

export type Persona = 'maker' | 'reviewer' | 'foreign';

export interface GateAccount {
  role: Persona;
  username: string;
  password: string;
  totpSecret: string;
  tenantId: string;
  tenantSlug: string;
  dcUserId: string;
}

export interface GateStep {
  stepId: string;
  title: string;
  expected: string;
  stateLabel: 'REAL_STATE' | 'SIMULATION_ONLY';
}

export interface GateState {
  apiUrl: string;
  consoleOrigin: string;
  buildSha: string;
  fixture: {
    tag: string;
    tenants: Record<'a' | 'b', { id: string; slug: string; teamId: string }>;
    users: Record<Persona, { id: string; tenant: 'a' | 'b' }>;
    fixturePack: { environment: string; packVersion: string; digest: string };
  };
  accounts: Record<Persona, GateAccount>;
  stepCatalog: GateStep[];
  simulationFixture: Record<string, unknown>;
  screenshotDir: string;
  outputDir: string;
}

export function gateState(): GateState {
  const path = process.env.U1_GATE_STATE;
  if (!path) throw new Error('U1_GATE_STATE is required (รันผ่าน `pnpm cxa:u1:acceptance`)');
  return JSON.parse(readFileSync(path, 'utf8')) as GateState;
}

/** RFC 6238 TOTP ด้วย secret ดิบแบบที่ Keycloak เก็บ (UTF-8 bytes) — เหมือน scripts/keycloak-platform-login.mjs */
function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const digest = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Keycloak ไม่รับ OTP ซ้ำใน window เดิม — บัญชีเดียวกัน login ซ้ำต้องรอ window ถัดไป */
const usedWindow = new Map<string, number>();
async function freshTotp(page: Page, secret: string): Promise<string> {
  let window = Math.floor(Date.now() / 30_000);
  if (usedWindow.get(secret) === window) {
    await page.waitForTimeout((window + 1) * 30_000 - Date.now() + 500);
    window = Math.floor(Date.now() / 30_000);
  }
  // เหลือเวลาใน window น้อยเกินไป = รอ window ใหม่ ไม่ให้รหัสหมดอายุระหว่างส่งฟอร์ม
  const remaining = (window + 1) * 30_000 - Date.now();
  if (remaining < 3_000) {
    await page.waitForTimeout(remaining + 500);
    window = Math.floor(Date.now() / 30_000);
  }
  usedWindow.set(secret, window);
  return totp(secret);
}

export interface Session {
  account: GateAccount;
  context: BrowserContext;
  page: Page;
  /** bearer token ล่าสุดที่ Console ส่งไป API (อ่านจาก request ของ browser เอง) */
  token(): string;
}

/**
 * login ผ่าน UI จริงของ Console: ปุ่มเข้าสู่ระบบ → ฟอร์มรหัสผ่านของ Keycloak → ฟอร์ม OTP → กลับมาที่
 * Console (Authorization Code + PKCE) — ไม่ใช้ direct grant และไม่ฉีด token
 */
export async function login(browser: Browser, account: GateAccount): Promise<Session> {
  const context = await browser.newContext();
  const page = await context.newPage();
  let bearer = '';
  page.on('request', (request) => {
    const header = request.headers().authorization;
    if (header?.startsWith('Bearer ') && new URL(request.url()).pathname.startsWith('/api/v1/'))
      bearer = header.slice('Bearer '.length);
  });
  await page.goto(`/?view=journeys&tenant=${account.tenantSlug}`);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await page.locator('#username').fill(account.username);
  await page.locator('#password').fill(account.password);
  await page.locator('#kc-login').click();
  await page.locator('#otp').fill(await freshTotp(page, account.totpSecret));
  await page.locator('#kc-login').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Journey authoring' })).toBeVisible();
  // callback ต้องไม่ทิ้ง code/state ไว้ใน URL (screenshot/หลักฐานห้ามมี — #379)
  await expect.poll(() => page.url()).not.toMatch(/[?&](code|state|session_state)=/);
  await expect.poll(() => bearer).not.toBe('');
  return { account, context, page, token: () => bearer };
}

/**
 * reload หน้าแบบที่ผู้ทดสอบทำ: session ของ Console อยู่ในหน่วยความจำ จึงต้องกดเข้าสู่ระบบอีกครั้ง —
 * Keycloak มี SSO session อยู่แล้วจึงกลับมาทันทีโดยไม่ถามรหัสผ่าน/OTP ซ้ำ
 */
export async function reloadSession(session: Session): Promise<void> {
  const { page, account } = session;
  await page.goto(`/?view=journeys&tenant=${account.tenantSlug}`);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Journey authoring' })).toBeVisible();
  await expect.poll(() => page.url()).not.toMatch(/[?&](code|state|session_state)=/);
}

export interface ApiResult {
  status: number;
  body: Record<string, unknown> & { code?: string };
}

/** เรียก API จริงผ่าน origin ของ Console (same-origin proxy แบบ UAT) ด้วย token ของ session */
export async function api(
  state: GateState,
  session: Session | null,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  init: { body?: unknown; key?: string; headers?: Record<string, string> } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...init.headers };
  if (session) headers.authorization = `Bearer ${session.token()}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['idempotency-key'] = init.key ?? `u1-gate-${crypto.randomUUID()}`;
  const response = await fetch(`${state.consoleOrigin}/api/v1/${path}`, {
    method,
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  let body: ApiResult['body'] = {};
  try {
    body = text ? (JSON.parse(text) as ApiResult['body']) : {};
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body };
}

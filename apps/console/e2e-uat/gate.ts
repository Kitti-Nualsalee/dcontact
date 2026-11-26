import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { th } from '../e2e/support/catalog';

/**
 * U1.7 (#435): helpers of the acceptance gate — state comes from the runner (`scripts/u1-acceptance.mjs`) through a
 * temporary file the runner deletes itself when done; the password/TOTP secret/token live in memory only and are never written as evidence
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
  if (!path) throw new Error('U1_GATE_STATE is required (run through `pnpm cxa:u1:acceptance`)');
  return JSON.parse(readFileSync(path, 'utf8')) as GateState;
}

/** RFC 6238 TOTP with the raw secret as Keycloak stores it (UTF-8 bytes) — same as scripts/keycloak-platform-login.mjs */
function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const digest = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Keycloak does not accept a repeated OTP within the same window — logging in again with the same account must wait for the next window */
const usedWindow = new Map<string, number>();
async function freshTotp(page: Page, secret: string): Promise<string> {
  let window = Math.floor(Date.now() / 30_000);
  if (usedWindow.get(secret) === window) {
    await page.waitForTimeout((window + 1) * 30_000 - Date.now() + 500);
    window = Math.floor(Date.now() / 30_000);
  }
  // too little time left in the window = wait for a new window so the code does not expire while the form is submitted
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
  /** latest bearer token the Console sent to the API (read from the browser's own requests) */
  token(): string;
}

/**
 * log in through the real Console UI: sign-in button → Keycloak password form → OTP form → back to
 * Console (Authorization Code + PKCE) — no direct grant and no injected token
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
  await page.getByRole('button', { name: th('common:auth.signIn') }).click();
  await page.locator('#username').fill(account.username);
  await page.locator('#password').fill(account.password);
  await page.locator('#kc-login').click();
  await page.locator('#otp').fill(await freshTotp(page, account.totpSecret));
  await page.locator('#kc-login').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Journey authoring' })).toBeVisible();
  // the callback must not leave code/state in the URL (screenshots/evidence must not contain them — #379)
  await expect.poll(() => page.url()).not.toMatch(/[?&](code|state|session_state)=/);
  await expect.poll(() => bearer).not.toBe('');
  return { account, context, page, token: () => bearer };
}

/**
 * reload the page the way a tester does: the Console session lives in memory, so the sign-in button must be pressed again —
 * Keycloak already has an SSO session, so it returns immediately without asking for the password/OTP again
 */
export async function reloadSession(session: Session): Promise<void> {
  const { page, account } = session;
  await page.goto(`/?view=journeys&tenant=${account.tenantSlug}`);
  await page.getByRole('button', { name: th('common:auth.signIn') }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Journey authoring' })).toBeVisible();
  await expect.poll(() => page.url()).not.toMatch(/[?&](code|state|session_state)=/);
}

export interface ApiResult {
  status: number;
  body: Record<string, unknown> & { code?: string };
}

/** call the real API through the Console origin (same-origin proxy like UAT) with the session's token */
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

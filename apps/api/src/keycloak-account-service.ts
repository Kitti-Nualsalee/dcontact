/**
 * Owner: IAM — client ฝั่ง server ของ service account `dcontact-account-service` (AC2 #595, ADR-033)
 *
 * - token แบบ client_credentials ของ realm เดียวกับ issuer, cache ไว้จนใกล้หมดอายุ; 401 = ขอ token ใหม่แล้วลองซ้ำครั้งเดียว
 * - เรียก extension `dc-account` (`{issuer}/dc-account/...`) เท่านั้น — account service ไม่มีสิทธิ์จัดการ
 *   Organization ผ่าน Admin REST (เจ้าของงานเลือก 2026-10-06 แทนการให้สิทธิ์ manage Organizations)
 * - ทุกความล้มเหลว (เครือข่าย, timeout, status ที่ไม่คาด) = `AccountPolicyError('IDENTITY_UNAVAILABLE')`
 *   โดยไม่แนบ body/secret ของ Keycloak ไปกับ error
 */
import { AccountPolicyError, type OrganizationMfaPort } from './account-policy.js';

export const ACCOUNT_SERVICE_CLIENT_ID = 'dcontact-account-service';

export interface KeycloakAccountServiceOptions {
  /** issuer ของ realm เช่น `http://localhost:8081/realms/dcontact` */
  issuer: string;
  clientSecret: string;
  clientId?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/** เผื่อเวลาก่อน token หมดอายุ — ไม่ส่ง token ที่จะหมดระหว่างทาง */
const TOKEN_EXPIRY_MARGIN_MS = 30_000;

export class KeycloakAccountServiceClient {
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private cached?: { token: string; expiresAt: number };

  constructor(private readonly options: KeycloakAccountServiceOptions) {
    this.issuer = options.issuer.replace(/\/+$/, '');
    this.clientId = options.clientId ?? ACCOUNT_SERVICE_CLIENT_ID;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** เรียก `{issuer}/dc-account/{path}` — คืน status และ body (JSON หรือ undefined) */
  async extension(
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    let response = await this.send(method, path, body, await this.token());
    if (response.status === 401) {
      this.cached = undefined;
      response = await this.send(method, path, body, await this.token());
    }
    const text = await response.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: response.status, body: parsed };
  }

  private async send(method: string, path: string, body: unknown, token: string) {
    return this.request(`${this.issuer}/dc-account/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - TOKEN_EXPIRY_MARGIN_MS > this.now()) {
      return this.cached.token;
    }
    const response = await this.request(`${this.issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.options.clientSecret,
      }),
    });
    if (!response.ok) throw new AccountPolicyError('IDENTITY_UNAVAILABLE');
    const payload = (await response.json().catch(() => undefined)) as
      { access_token?: unknown; expires_in?: unknown } | undefined;
    if (typeof payload?.access_token !== 'string') {
      throw new AccountPolicyError('IDENTITY_UNAVAILABLE');
    }
    const lifetime = typeof payload.expires_in === 'number' ? payload.expires_in : 60;
    this.cached = { token: payload.access_token, expiresAt: this.now() + lifetime * 1000 };
    return payload.access_token;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new AccountPolicyError('IDENTITY_UNAVAILABLE');
    }
  }
}

/** port ของ AC1: เขียน `dc_mfa_required` ของ Organization ของ tenant ผ่าน extension (idempotent) */
export class KeycloakOrganizationMfa implements OrganizationMfaPort {
  constructor(private readonly client: KeycloakAccountServiceClient) {}

  async setMfaRequired(tenantId: string, required: boolean): Promise<void> {
    const { status } = await this.client.extension(
      'PUT',
      `organizations/by-tenant/${encodeURIComponent(tenantId)}/mfa-required`,
      { required },
    );
    if (status !== 204) throw new AccountPolicyError('IDENTITY_UNAVAILABLE');
  }
}

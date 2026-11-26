/**
 * Owner: IAM — the server-side client of the `dcontact-account-service` service account (AC2 #595, ADR-033)
 *
 * - a client_credentials token of the same realm as the issuer, cached until close to expiry; 401 = request a new token and retry once
 * - calls the `dc-account` extension (`{issuer}/dc-account/...`) — the account service has no permission to manage
 *   Organizations through the Admin REST (the owner chose on 2026-10-06 instead of granting the manage Organizations permission)
 * - AC4 (#597): the user Admin REST (`{admin}/users/...`) under the fine-grained permission of ADR-033
 *   (view/manage/reset-password on the tenant's users only)
 * - every failure (network, timeout, an unexpected status) = `AccountPolicyError('IDENTITY_UNAVAILABLE')`
 *   without attaching the Keycloak body/secret to the error
 */
import { AccountPolicyError, type OrganizationMfaPort } from './account-policy.js';

export const ACCOUNT_SERVICE_CLIENT_ID = 'dcontact-account-service';

export interface KeycloakAccountServiceOptions {
  /** the realm issuer, e.g. `http://localhost:8081/realms/dcontact` */
  issuer: string;
  clientSecret: string;
  clientId?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/** a margin before the token expires — do not send a token that will expire in flight */
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

  /** calls `{issuer}/dc-account/{path}` — returns the status and body (JSON or undefined) */
  extension(method: 'POST' | 'PUT', path: string, body: unknown) {
    return this.call(method, `${this.issuer}/dc-account/${path}`, body);
  }

  /**
   * calls the realm's Admin REST (`{origin}[/auth]/admin/realms/{realm}/{path}`) with the account service token
   * — permission is limited by the fine-grained permission (ADR-033), not a realm-management role
   */
  admin(method: 'GET' | 'PUT' | 'DELETE', path: string, body?: unknown) {
    return this.call(method, `${this.adminBase()}/${path}`, body);
  }

  private adminBase() {
    const index = this.issuer.lastIndexOf('/realms/');
    if (index < 0) throw new AccountPolicyError('IDENTITY_UNAVAILABLE');
    return `${this.issuer.slice(0, index)}/admin${this.issuer.slice(index)}`;
  }

  private async call(
    method: string,
    url: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    let response = await this.send(method, url, body, await this.token());
    if (response.status === 401) {
      this.cached = undefined;
      response = await this.send(method, url, body, await this.token());
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

  private async send(method: string, url: string, body: unknown, token: string) {
    return this.request(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

/** the AC1 port: writes `dc_mfa_required` of the tenant's Organization through the extension (idempotent) */
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

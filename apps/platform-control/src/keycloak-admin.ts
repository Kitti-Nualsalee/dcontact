/**
 * Owner: IAM provisioning — Keycloak Admin REST client for the saga adapters (A1.4 #409)
 *
 * - uses the service account `dcontact-provisioner` (client_credentials), not an admin of the master realm
 * - errors are converted to `ProvisioningStepError` carrying only a machine code: never carry a response body, email,
 *   token or URL with the user's query out to the log/receipt/audit
 * - timeout/network failure of a write command = `AMBIGUOUS` (it may have happened), of a read command = `TRANSIENT`
 *
 * Keycloak 26.0: the Organization admin API needs realm-management `manage-realm`
 * (no fine-grained admin permission yet) — so this client's secret must live only in the worker
 */
import { SpanKind } from '@opentelemetry/api';
import { keycloakOperation, setSpanAttributes, withSpan } from './platform-tracing.js';
import { ProvisioningStepError } from './provisioning-saga.js';

export interface KeycloakAdminOptions {
  baseUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
  /** injectable to simulate a lost response/timeout in tests */
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface KeycloakResponse<T = unknown> {
  status: number;
  body: T;
  location: string | null;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export class KeycloakAdminClient {
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;
  private token: { value: string; expiresAt: number } | undefined;

  constructor(private readonly options: KeycloakAdminOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  get realm() {
    return this.options.realm;
  }

  /**
   * Calls `/admin/realms/{realm}{path}` — a status listed in `accept` is returned for the caller to decide
   * (e.g. 404 = absent, 409 = clash); anything else is converted to a step error
   */
  async admin<T = unknown>(
    method: Method,
    path: string,
    init: { body?: unknown; rawBody?: string; signal?: AbortSignal; accept?: number[] } = {},
  ): Promise<KeycloakResponse<T>> {
    // A1.8b: span per call — the name is a path template (id → {id}, no query that may contain an email)
    const operation = keycloakOperation(method, path);
    return withSpan(
      `keycloak ${operation}`,
      { kind: SpanKind.CLIENT, attributes: { 'keycloak.operation': operation } },
      async (span) => {
        const response = await this.call<T>(method, path, init);
        setSpanAttributes(span, { 'http.response.status_code': response.status });
        return response;
      },
    );
  }

  private async call<T>(
    method: Method,
    path: string,
    init: { body?: unknown; rawBody?: string; signal?: AbortSignal; accept?: number[] },
  ): Promise<KeycloakResponse<T>> {
    const accept = init.accept ?? [200, 201, 204];
    for (let round = 0; round < 2; round += 1) {
      const token = await this.accessToken(init.signal, round > 0);
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (init.body !== undefined || init.rawBody !== undefined) {
        headers['content-type'] = 'application/json';
      }
      let response: Response;
      try {
        response = await this.fetch(
          `${this.options.baseUrl}/admin/realms/${encodeURIComponent(this.options.realm)}${path}`,
          {
            method,
            headers,
            body: init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
            ...(init.signal ? { signal: init.signal } : {}),
          },
        );
      } catch {
        throw unreachable(method, init.signal);
      }
      // the token expired along the way: request a new one once (the command was not processed because the 401 came first)
      if (response.status === 401 && round === 0) continue;
      const text = await response.text().catch(() => '');
      if (!accept.includes(response.status)) throw statusError(method, response.status);
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      return {
        status: response.status,
        body: body as T,
        location: response.headers.get('location'),
      };
    }
    throw new ProvisioningStepError('PERMANENT', 'KEYCLOAK_UNAUTHORIZED');
  }

  private async accessToken(signal: AbortSignal | undefined, refresh: boolean): Promise<string> {
    const now = this.now().getTime();
    if (!refresh && this.token && this.token.expiresAt - 10_000 > now) return this.token.value;
    let response: Response;
    try {
      response = await this.fetch(
        `${this.options.baseUrl}/realms/${encodeURIComponent(this.options.realm)}/protocol/openid-connect/token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.options.clientId,
            client_secret: this.options.clientSecret,
          }),
          ...(signal ? { signal } : {}),
        },
      );
    } catch {
      // no command has been sent yet — safe to retry
      throw new ProvisioningStepError('TRANSIENT', 'KEYCLOAK_UNREACHABLE');
    }
    if (response.status >= 500)
      throw new ProvisioningStepError('TRANSIENT', 'KEYCLOAK_UNAVAILABLE');
    if (!response.ok) throw new ProvisioningStepError('PERMANENT', 'KEYCLOAK_UNAUTHORIZED');
    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: now + body.expires_in * 1000 };
    return body.access_token;
  }
}

function unreachable(method: Method, signal: AbortSignal | undefined): ProvisioningStepError {
  const timedOut = signal?.aborted === true;
  if (method === 'GET') {
    return new ProvisioningStepError(
      'TRANSIENT',
      timedOut ? 'EXTERNAL_TIMEOUT' : 'KEYCLOAK_UNREACHABLE',
    );
  }
  // a write command may have reached Keycloak — next round must ask find first
  return new ProvisioningStepError(
    'AMBIGUOUS',
    timedOut ? 'EXTERNAL_TIMEOUT' : 'KEYCLOAK_UNREACHABLE',
  );
}

function statusError(method: Method, status: number): ProvisioningStepError {
  if (status === 403) return new ProvisioningStepError('PERMANENT', 'KEYCLOAK_FORBIDDEN');
  if (status === 429) return new ProvisioningStepError('TRANSIENT', 'KEYCLOAK_RATE_LIMITED');
  if (status >= 500) {
    return new ProvisioningStepError(
      method === 'GET' ? 'TRANSIENT' : 'AMBIGUOUS',
      'KEYCLOAK_SERVER_ERROR',
    );
  }
  return new ProvisioningStepError('PERMANENT', 'KEYCLOAK_REJECTED');
}

/**
 * Owner: IAM provisioning — Keycloak Admin REST client ของ saga adapters (A1.4 #409)
 *
 * - ใช้ service account `dcontact-provisioner` (client_credentials) ไม่ใช่ admin ของ master realm
 * - error ถูกแปลงเป็น `ProvisioningStepError` ที่มีแค่ machine code: ห้ามพก response body, email,
 *   token หรือ URL ที่มี query ของผู้ใช้ออกไปถึง log/receipt/audit
 * - timeout/network failure ของคำสั่งที่เขียน = `AMBIGUOUS` (อาจเกิดแล้ว) ส่วนคำสั่งอ่าน = `TRANSIENT`
 *
 * Keycloak 26.0: Organization admin API ต้องใช้ realm-management `manage-realm`
 * (ยังไม่มี fine-grained admin permission) — secret ของ client นี้จึงต้องอยู่เฉพาะ worker
 */
import { ProvisioningStepError } from './provisioning-saga.js';

export interface KeycloakAdminOptions {
  baseUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
  /** inject ได้สำหรับจำลอง lost response/timeout ในเทสต์ */
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
   * เรียก `/admin/realms/{realm}{path}` — status ที่อยู่ใน `accept` คืนให้ผู้เรียกตัดสินเอง
   * (เช่น 404 = ไม่มี, 409 = ชนกัน) นอกนั้นแปลงเป็น step error
   */
  async admin<T = unknown>(
    method: Method,
    path: string,
    init: { body?: unknown; rawBody?: string; signal?: AbortSignal; accept?: number[] } = {},
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
      // token หมดอายุระหว่างทาง: ขอใหม่หนึ่งครั้ง (คำสั่งยังไม่ถูกประมวลผลเพราะ 401 มาก่อน)
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
      // ยังไม่ได้ส่งคำสั่งใด ๆ — retry ได้โดยไม่เสี่ยง
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
  // คำสั่งเขียนอาจถึง Keycloak แล้ว — รอบหน้าต้องถาม find ก่อน
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

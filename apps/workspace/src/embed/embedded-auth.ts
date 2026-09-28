/**
 * E1.13 (#487): auth ของ dphone ที่ถูกฝัง (E1.4 #460 ข้อ 2–5)
 *
 * - login ผ่าน popup ที่เปิดจาก user gesture เท่านั้น (ไม่มี silent SSO, `monitorSession` หรือ iframe renew)
 *   PKCE S256 + `state` เตรียมไว้ล่วงหน้าด้วย `prepare()` เพื่อให้ `login()` เปิด popup แบบ synchronous ได้
 * - callback (`/dphone/auth/callback`) ส่ง `code`/`state` กลับด้วย exact targetOrigin = dphone origin —
 *   รับเฉพาะข้อความที่ `origin` เป็นของเราและ `source` เป็น popup ที่เปิดเอง แลก code ที่นี่ (verifier อยู่ใน memory)
 * - access token อยู่ใน memory เท่านั้น; refresh token (ใช้ครั้งเดียว) อยู่ใน `sessionStorage` ของ iframe
 *   ซึ่ง browser partition ตาม host (top-level site) — reload host แล้วยังอยู่ในระบบ
 * - refresh ล้มเหลวจาก network: backoff; `invalid_grant` (หมดอายุ/ถูก revoke/reuse/session cap) → `reauth`
 *   ระหว่างนั้นคำสั่ง API รอในคิว memory จน login ใหม่ — สายไม่ถูกตัดเพราะ auth
 * - logout ได้เฉพาะตอนว่าง: ปล่อย lease → revoke refresh token → ล้าง storage (ไม่ logout SSO ทั้ง realm)
 * - token ไม่ออกนอก iframe: ไม่มี API ใดคืน token ให้ host; `fetch()` แนบ header ให้เอง
 */

export const DPHONE_AUTH_CALLBACK_MESSAGE = 'dphone.auth.callback';
export const REFRESH_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
/** refresh ก่อน access หมดอายุ (access 5 นาที) */
const REFRESH_SKEW_MS = 30_000;

export type EmbeddedAuthStatus =
  | 'signed-out' // ยังไม่ login (หรือ logout แล้ว)
  | 'signing-in' // popup เปิดอยู่ / กำลังแลก code
  | 'popup-blocked' // browser บล็อก popup — ต้องกดปุ่มอีกครั้ง
  | 'signed-in'
  | 'refreshing' // refresh ล้มเหลวชั่วคราว กำลัง backoff
  | 'reauth'; // ต้อง login ใหม่ — คำสั่ง API รอในคิว

export interface EmbeddedAuthConfig {
  issuer: string;
  clientId: string;
  tenant: string;
  /** origin ของ dphone (iframe) — redirect กลับ `/dphone/auth/callback` บน origin นี้ */
  origin: string;
}

interface PopupLike {
  closed: boolean;
  close(): void;
}

export interface EmbeddedAuthDeps {
  fetch: typeof fetch;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  openPopup(url: string): PopupLike | null;
  randomBytes(length: number): Uint8Array;
  sha256(input: string): Promise<Uint8Array>;
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

class TokenEndpointError extends Error {
  constructor(
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(code);
  }
}

interface PendingLogin {
  state: string;
  verifier: string;
  url: string;
  popup?: PopupLike | null;
}

interface QueuedRequest {
  input: string;
  init: RequestInit;
  resolve(response: Response): void;
  reject(error: unknown): void;
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class EmbeddedAuth {
  private accessToken_: string | null = null;
  private accessExpiresAt = 0;
  private refreshTimer: unknown = null;
  private refreshAttempt = 0;
  private refreshing: Promise<void> | null = null;
  private pending: PendingLogin | null = null;
  private readonly queue: QueuedRequest[] = [];
  private readonly listeners = new Set<(status: EmbeddedAuthStatus) => void>();
  private current: EmbeddedAuthStatus = 'signed-out';

  constructor(
    private readonly config: EmbeddedAuthConfig,
    private readonly deps: EmbeddedAuthDeps,
  ) {}

  get status(): EmbeddedAuthStatus {
    return this.current;
  }

  /**
   * access token ที่ยังไม่หมดอายุ — ใช้ภายใน iframe เท่านั้น (WS `auth:connect`); ห้ามส่งออกไป host
   */
  accessToken(): string | undefined {
    return this.accessToken_ && this.deps.now() < this.accessExpiresAt
      ? this.accessToken_
      : undefined;
  }

  /** จำนวนคำสั่ง API ที่รอ token อยู่ */
  get queued(): number {
    return this.queue.length;
  }

  subscribe(listener: (status: EmbeddedAuthStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private get storageKey(): string {
    return `dphone.embed.refresh.${this.config.tenant}`;
  }

  private get redirectUri(): string {
    return new URL('/dphone/auth/callback', this.config.origin).toString();
  }

  private get tokenEndpoint(): string {
    return `${this.config.issuer}/protocol/openid-connect/token`;
  }

  private setStatus(status: EmbeddedAuthStatus) {
    if (status === this.current) return;
    this.current = status;
    for (const listener of this.listeners) listener(status);
  }

  /** เริ่มต้น: มี refresh token ใน sessionStorage (reload host) → refresh ทันที */
  async start(): Promise<void> {
    if (this.deps.storage.getItem(this.storageKey)) await this.refresh();
    if (this.current === 'signed-out' || this.current === 'reauth') await this.prepare();
  }

  /** เตรียม PKCE + state ไว้ก่อน เพื่อให้ `login()` เปิด popup ใน user gesture ได้ทันที */
  async prepare(): Promise<void> {
    const verifier = base64Url(this.deps.randomBytes(32));
    const state = base64Url(this.deps.randomBytes(16));
    const challenge = base64Url(await this.deps.sha256(verifier));
    const url = new URL(`${this.config.issuer}/protocol/openid-connect/auth`);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: `openid organization:${this.config.tenant}`,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    this.pending = { state, verifier, url: url.toString() };
  }

  /** เรียกจาก click handler เท่านั้น — เปิด popup แบบ synchronous */
  login(): void {
    const pending = this.pending;
    if (!pending) return;
    const popup = this.deps.openPopup(pending.url);
    if (!popup) {
      this.setStatus('popup-blocked');
      return;
    }
    pending.popup = popup;
    this.setStatus('signing-in');
  }

  /**
   * ข้อความจาก `window` ของ iframe — รับเฉพาะ callback จาก popup ที่เปิดเองบน origin ของเรา
   * คืน true เมื่อเป็นข้อความ callback ที่ถูกใช้
   */
  async handleMessage(event: { origin: string; source: unknown; data: unknown }): Promise<boolean> {
    const pending = this.pending;
    if (!pending?.popup || event.origin !== this.config.origin || event.source !== pending.popup) {
      return false;
    }
    const data = event.data as { type?: unknown; code?: unknown; state?: unknown } | null;
    if (!data || data.type !== DPHONE_AUTH_CALLBACK_MESSAGE) return false;
    this.pending = null;
    if (data.state !== pending.state || typeof data.code !== 'string' || !data.code) {
      await this.failLogin();
      return true;
    }
    try {
      this.accept(
        await this.tokenRequest({
          grant_type: 'authorization_code',
          code: data.code,
          code_verifier: pending.verifier,
          redirect_uri: this.redirectUri,
        }),
      );
    } catch {
      await this.failLogin();
    }
    return true;
  }

  /** popup ถูกปิดโดยไม่มี callback */
  async popupClosed(): Promise<void> {
    if (this.current !== 'signing-in' || this.pending?.popup?.closed === false) return;
    await this.failLogin();
  }

  private async failLogin() {
    this.setStatus(this.queue.length ? 'reauth' : 'signed-out');
    await this.prepare();
  }

  /**
   * fetch พร้อม bearer token — ตอนต้อง login ใหม่หรือกำลัง refresh คำสั่งจะรอในคิว memory
   * (ไม่ทิ้ง ไม่ส่งซ้ำ) แล้วส่งเมื่อได้ token ใหม่
   */
  fetch(input: string, init: RequestInit = {}): Promise<Response> {
    if (this.accessToken_ && this.deps.now() < this.accessExpiresAt && !this.refreshing) {
      return this.send(input, init);
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ input, init, resolve, reject });
      if (this.current === 'signed-in') void this.refresh();
    });
  }

  private send(input: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.accessToken_}`);
    return this.deps.fetch(input, { ...init, headers });
  }

  private flushQueue() {
    for (const request of this.queue.splice(0)) {
      this.send(request.input, request.init).then(request.resolve, request.reject);
    }
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.runRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async runRefresh(): Promise<void> {
    const refreshToken = this.deps.storage.getItem(this.storageKey);
    if (!refreshToken) {
      this.requireReauth();
      return;
    }
    try {
      this.accept(
        await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      );
    } catch (error) {
      if (error instanceof TokenEndpointError && error.permanent) {
        this.requireReauth();
        return;
      }
      const delay = REFRESH_BACKOFF_MS[this.refreshAttempt];
      if (delay === undefined) {
        this.requireReauth();
        return;
      }
      this.refreshAttempt += 1;
      this.setStatus('refreshing');
      this.schedule(delay);
    }
  }

  /** refresh token ใช้ไม่ได้แล้ว — ล้าง token แต่เก็บคิวไว้รอ login ใหม่ */
  private requireReauth() {
    this.clearTokens();
    this.setStatus('reauth');
    void this.prepare();
  }

  private accept(tokens: TokenResponse) {
    this.accessToken_ = tokens.access_token;
    this.accessExpiresAt = this.deps.now() + tokens.expires_in * 1_000;
    // refresh ใช้ครั้งเดียว: เก็บตัวใหม่ทับทุกครั้ง
    if (tokens.refresh_token) this.deps.storage.setItem(this.storageKey, tokens.refresh_token);
    this.refreshAttempt = 0;
    this.setStatus('signed-in');
    this.schedule(Math.max(tokens.expires_in * 1_000 - REFRESH_SKEW_MS, 0));
    this.flushQueue();
  }

  private schedule(ms: number) {
    if (this.refreshTimer !== null) this.deps.clearTimeout(this.refreshTimer);
    this.refreshTimer = this.deps.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, ms);
  }

  private clearTokens() {
    this.accessToken_ = null;
    this.accessExpiresAt = 0;
    this.refreshAttempt = 0;
    if (this.refreshTimer !== null) this.deps.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.deps.storage.removeItem(this.storageKey);
  }

  private async tokenRequest(fields: Record<string, string>): Promise<TokenResponse> {
    const response = await this.deps.fetch(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.clientId, ...fields }).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as Partial<TokenResponse> & {
      error?: string;
    };
    if (!response.ok || typeof body.access_token !== 'string') {
      const code = typeof body.error === 'string' ? body.error : `http_${response.status}`;
      // 4xx จาก token endpoint = token ใช้ไม่ได้แล้ว (invalid_grant: หมดอายุ/revoke/reuse/session cap)
      throw new TokenEndpointError(code, response.status >= 400 && response.status < 500);
    }
    return body as TokenResponse;
  }

  /**
   * สายจบระหว่างที่ต้อง login ใหม่ → ไม่พร้อมรับสายและปล่อย lease (คำสั่งเข้าคิวรอ token ใหม่)
   * ตอน auth ปกติไม่ทำอะไร — คืน true เมื่อสั่งแล้ว
   */
  afterCallEnded(actions: { setNotReady(): Promise<unknown>; releaseLease(): Promise<unknown> }) {
    if (this.current !== 'reauth' && this.current !== 'refreshing') return false;
    void actions.setNotReady().then(() => actions.releaseLease());
    return true;
  }

  /**
   * logout เฉพาะตอนว่าง (ไม่มีสาย/wrap-up): ปล่อย lease → revoke refresh token → ล้าง storage
   * ไม่เรียก end-session ของ realm (SSO ของแอปอื่นยังอยู่)
   */
  async logout(input: { busy: boolean; releaseLease(): Promise<void> }): Promise<boolean> {
    if (input.busy) return false;
    await input.releaseLease();
    const refreshToken = this.deps.storage.getItem(this.storageKey);
    if (refreshToken) {
      await this.deps
        .fetch(`${this.config.issuer}/protocol/openid-connect/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: this.config.clientId,
            token: refreshToken,
            token_type_hint: 'refresh_token',
          }).toString(),
        })
        .catch(() => undefined);
    }
    this.clearTokens();
    for (const request of this.queue.splice(0)) request.reject(new Error('signed out'));
    this.setStatus('signed-out');
    await this.prepare();
    return true;
  }
}

/** deps จริงของ browser */
export function browserAuthDeps(win: Window): EmbeddedAuthDeps {
  return {
    fetch: win.fetch.bind(win),
    storage: win.sessionStorage,
    openPopup: (url) => win.open(url, 'dphone-auth', 'popup,width=480,height=640'),
    randomBytes: (length) => win.crypto.getRandomValues(new Uint8Array(length)),
    sha256: async (input) =>
      new Uint8Array(await win.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))),
    now: () => Date.now(),
    setTimeout: (callback, ms) => win.setTimeout(callback, ms),
    clearTimeout: (handle) => win.clearTimeout(handle as number),
  };
}

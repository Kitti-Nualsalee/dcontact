/**
 * E1.13 (#487): auth for the embedded dphone (E1.4 #460 items 2–5)
 *
 * - login only through a popup opened from a user gesture (no silent SSO, `monitorSession` or iframe renew)
 *   PKCE S256 + `state` are prepared ahead with `prepare()` so `login()` can open the popup synchronously
 * - the callback (`/dphone/auth/callback`) sends `code`/`state` back with an exact targetOrigin = the dphone origin —
 *   accept only messages whose `origin` is ours and whose `source` is the popup we opened; exchange the code here (the verifier stays in memory)
 * - the access token lives only in memory; the refresh token (single use) lives in the iframe's `sessionStorage`
 *   which the browser partitions by host (top-level site) — reloading the host keeps the session
 * - refresh failing from the network: backoff; `invalid_grant` (expired/revoked/reuse/session cap) → `reauth`
 *   meanwhile API commands wait in the memory queue until a new login — a call is not cut because of auth
 * - logout only when idle: release the lease → revoke the refresh token → clear storage (does not log out SSO for the whole realm)
 * - the token never leaves the iframe: no API returns the token to the host; `fetch()` attaches the header itself
 */

export const DPHONE_AUTH_CALLBACK_MESSAGE = 'dphone.auth.callback';
export const REFRESH_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
/** refresh before the access token expires (access lasts 5 minutes) */
const REFRESH_SKEW_MS = 30_000;

export type EmbeddedAuthStatus =
  | 'signed-out' // not logged in yet (or logged out)
  | 'signing-in' // popup is open / exchanging the code
  | 'popup-blocked' // the browser blocked the popup — the button must be pressed again
  | 'signed-in'
  | 'refreshing' // refresh failed temporarily, backing off
  | 'reauth'; // must log in again — API commands wait in the queue

export interface EmbeddedAuthConfig {
  issuer: string;
  clientId: string;
  tenant: string;
  /** origin of dphone (iframe) — redirects back to `/dphone/auth/callback` on this origin */
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
   * access token that has not expired — used only inside the iframe (WS `auth:connect`); must not be sent out to the host
   */
  accessToken(): string | undefined {
    return this.accessToken_ && this.deps.now() < this.accessExpiresAt
      ? this.accessToken_
      : undefined;
  }

  /** number of API commands waiting for a token */
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

  /** start: there is a refresh token in sessionStorage (host reload) → refresh immediately */
  async start(): Promise<void> {
    if (this.deps.storage.getItem(this.storageKey)) await this.refresh();
    if (this.current === 'signed-out' || this.current === 'reauth') await this.prepare();
  }

  /** prepare PKCE + state ahead so `login()` can open the popup within a user gesture immediately */
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

  /** call only from a click handler — opens the popup synchronously */
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
   * message from the iframe's `window` — accept only the callback from the popup we opened, on our origin
   * returns true when it is a callback message that was consumed
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

  /** the popup was closed without a callback */
  async popupClosed(): Promise<void> {
    if (this.current !== 'signing-in' || this.pending?.popup?.closed === false) return;
    await this.failLogin();
  }

  private async failLogin() {
    this.setStatus(this.queue.length ? 'reauth' : 'signed-out');
    await this.prepare();
  }

  /**
   * fetch with a bearer token — while a new login is needed or a refresh is in progress the command waits in the memory queue
   * (not dropped, not resent) and is sent when a new token arrives
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

  /** the refresh token is unusable — clear the token but keep the queue waiting for a new login */
  private requireReauth() {
    this.clearTokens();
    this.setStatus('reauth');
    void this.prepare();
  }

  private accept(tokens: TokenResponse) {
    this.accessToken_ = tokens.access_token;
    this.accessExpiresAt = this.deps.now() + tokens.expires_in * 1_000;
    // the refresh token is single use: store the new one over the old every time
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
      // 4xx from the token endpoint = the token is unusable (invalid_grant: expired/revoke/reuse/session cap)
      throw new TokenEndpointError(code, response.status >= 400 && response.status < 500);
    }
    return body as TokenResponse;
  }

  /**
   * the call ended while a new login is needed → not ready for calls and release the lease (commands queue for the new token)
   * during normal auth it does nothing — returns true when it has issued the command
   */
  afterCallEnded(actions: { setNotReady(): Promise<unknown>; releaseLease(): Promise<unknown> }) {
    if (this.current !== 'reauth' && this.current !== 'refreshing') return false;
    void actions.setNotReady().then(() => actions.releaseLease());
    return true;
  }

  /**
   * logout only when idle (no call/wrap-up): release the lease → revoke the refresh token → clear storage
   * does not call the realm's end-session (SSO of other apps stays)
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

/** real deps of the browser */
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

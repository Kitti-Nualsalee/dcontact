/**
 * E1.12 (#486): client of the work-session lease (E1.9 #483) for Workspace and dphone
 *
 * Authority: E1.3 #459, Phase Contract E1.8 #464, ADR-026 items 2 and 4
 *
 * - the server decides the single work point per agent per tenant — the client only requests/renews/moves and stops taking work on losing the lease
 * - mandatory order: get the lease first, then connect the routing WS (with `leaseId`) and register SIP
 * - heartbeat over WS (`lease:heartbeat`) every `heartbeatSeconds` (20 seconds); the lease does not expire while there is work (server)
 * - `lease.revoked` / `lease.expired` / WS close 4409 = stop taking new work immediately; a call in progress is not cut (ADR-026 item 4)
 *   withdrawing the SIP register is the caller's job when `ownsWork` is false and there is no work in hand
 * - "move here" = a user-confirmed takeover with `expectedLeaseId`; if rejected (work pending/lease changed)
 *   nothing at the old place is touched — both its call and WS stay intact
 * - #583 (#582): every tenant enforces the lease — no flag and no "not enforced" state anymore
 *   SIP credentials are issued only to the lease holder (E1.10 #551); failing to read the lease state = error then retry (fail closed)
 */

export type WorkSessionSurface = 'workspace' | 'dphone' | 'embedded';
export type WorkSessionHolderSurface = WorkSessionSurface;

export interface WorkSessionHolder {
  leaseId: string;
  surface: WorkSessionHolderSurface;
  hostOrigin: string | null;
  acquiredAt: string;
  /** has a call or wrap-up — cannot move until the work ends */
  busy: boolean;
}

export interface WorkSessionLease {
  leaseId: string;
  surface: WorkSessionHolderSurface;
  hostOrigin: string | null;
  acquiredAt: string;
  expiresAt: string;
  ttlSeconds: number;
  heartbeatSeconds: number;
}

export interface WorkSessionStatus {
  holder: WorkSessionHolder | null;
}

export type WorkSessionErrorCode =
  | 'WORK_SESSION_HELD'
  | 'WORK_SESSION_BUSY'
  | 'WORK_SESSION_CHANGED'
  | 'AGENT_NOT_FOUND'
  | 'VALIDATION_FAILED';

export class WorkSessionRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly holder?: WorkSessionHolder,
  ) {
    super(code ?? `HTTP ${status}`);
    this.name = 'WorkSessionRequestError';
  }
}

export interface WorkSessionApi {
  status(): Promise<WorkSessionStatus>;
  acquire(surface: WorkSessionSurface): Promise<WorkSessionLease>;
  takeover(surface: WorkSessionSurface, expectedLeaseId: string): Promise<WorkSessionLease>;
  release(leaseId: string, options?: { keepalive?: boolean }): Promise<void>;
}

export interface WorkSessionApiOptions {
  baseUrl: string;
  accessToken(): string | undefined;
  fetch?: typeof globalThis.fetch;
  /** E1.14: host origin the iframe is locked to — sent with surface `embedded` so the server re-checks it against the allowlist */
  hostOrigin?: string;
  /** E1.14: fetch that attaches the token itself (see `AgentWorkspaceApiOptions.authorizedFetch`) */
  authorizedFetch?: (url: string, init: RequestInit) => Promise<Response>;
}

const PATH = '/api/v1/me/work-session';

function parseHolder(value: unknown): WorkSessionHolder | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const holder = value as Partial<WorkSessionHolder>;
  if (
    typeof holder.leaseId !== 'string' ||
    !['workspace', 'dphone', 'embedded'].includes(String(holder.surface)) ||
    typeof holder.acquiredAt !== 'string' ||
    typeof holder.busy !== 'boolean'
  ) {
    return undefined;
  }
  return {
    leaseId: holder.leaseId,
    surface: holder.surface as WorkSessionHolderSurface,
    hostOrigin: typeof holder.hostOrigin === 'string' ? holder.hostOrigin : null,
    acquiredAt: holder.acquiredAt,
    busy: holder.busy,
  };
}

function parseLease(value: unknown): WorkSessionLease {
  const lease = (value ?? {}) as Partial<WorkSessionLease>;
  if (
    typeof lease.leaseId !== 'string' ||
    typeof lease.expiresAt !== 'string' ||
    typeof lease.acquiredAt !== 'string'
  ) {
    throw new WorkSessionRequestError(502, 'MALFORMED_LEASE');
  }
  return {
    leaseId: lease.leaseId,
    surface: (lease.surface ?? 'workspace') as WorkSessionHolderSurface,
    hostOrigin: lease.hostOrigin ?? null,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    ttlSeconds: Number.isFinite(lease.ttlSeconds) ? Number(lease.ttlSeconds) : 60,
    heartbeatSeconds: Number.isFinite(lease.heartbeatSeconds) ? Number(lease.heartbeatSeconds) : 20,
  };
}

export function createWorkSessionApi(options: WorkSessionApiOptions): WorkSessionApi {
  const request = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const url = `${options.baseUrl.replace(/\/$/, '')}${PATH}`;

  async function call(
    method: string,
    path: string,
    body?: unknown,
    extra: { headers?: Record<string, string>; keepalive?: boolean } = {},
  ): Promise<{ status: number; body: unknown }> {
    const accessToken = options.authorizedFetch ? undefined : options.accessToken();
    if (!options.authorizedFetch && !accessToken) throw new WorkSessionRequestError(401);
    const send = options.authorizedFetch ?? request;
    const response = await send(`${url}${path}`, {
      method,
      headers: {
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(extra.keepalive ? { keepalive: true } : {}),
    });
    let parsed: unknown;
    try {
      parsed = response.status === 204 ? undefined : await response.json();
    } catch {
      parsed = undefined;
    }
    return { status: response.status, body: parsed };
  }

  const requestBody = (surface: WorkSessionSurface) =>
    surface === 'embedded' ? { surface, hostOrigin: options.hostOrigin ?? null } : { surface };

  function failure(result: { status: number; body: unknown }): WorkSessionRequestError {
    const envelope = (result.body ?? {}) as { code?: unknown; holder?: unknown };
    return new WorkSessionRequestError(
      result.status,
      typeof envelope.code === 'string' ? envelope.code : undefined,
      parseHolder(envelope.holder),
    );
  }

  return {
    async status() {
      const result = await call('GET', '');
      // #583: the lease is enforced for every tenant — 403/404/5xx is not "not enforced" but a failure that must be retried
      if (result.status !== 200) throw failure(result);
      const body = (result.body ?? {}) as { holder?: unknown };
      return { holder: parseHolder(body.holder) ?? null };
    },
    async acquire(surface) {
      const result = await call('POST', '', requestBody(surface));
      if (result.status !== 201 && result.status !== 200) throw failure(result);
      return parseLease(result.body);
    },
    async takeover(surface, expectedLeaseId) {
      const result = await call('POST', '/takeover', { ...requestBody(surface), expectedLeaseId });
      if (result.status !== 201 && result.status !== 200) throw failure(result);
      return parseLease(result.body);
    },
    async release(leaseId, releaseOptions = {}) {
      const result = await call('DELETE', '', undefined, {
        headers: { 'x-work-session-lease-id': leaseId },
        keepalive: releaseOptions.keepalive,
      });
      if (result.status !== 204 && result.status !== 200) throw failure(result);
    },
  };
}

// ── state machine ────────────────────────────────────────────────────────────

/** reason this place lost the lease — shown to the user so they know why work stopped */
export type WorkSessionLoss = 'takeover' | 'auth_revoked' | 'released' | 'expired';
/** takeover rejected — nothing changed, neither here nor at the old place */
export type WorkSessionRejection = 'busy' | 'changed' | 'failed';

export type WorkSessionState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'acquiring' }
  | { phase: 'held'; lease: WorkSessionLease }
  /** does not hold the lease: view only — someone else holds it or it has not started */
  | {
      phase: 'standby';
      holder: WorkSessionHolder | null;
      loss?: WorkSessionLoss;
      rejection?: WorkSessionRejection;
    }
  | { phase: 'takingOver'; holder: WorkSessionHolder; loss?: WorkSessionLoss }
  /** could not talk to the server — retry automatically */
  | { phase: 'error'; loss?: WorkSessionLoss };

export interface WorkSessionSocketSender {
  send(message: { type: 'lease:heartbeat'; leaseId: string }): void;
}

export interface WorkSessionTimers {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WorkSessionClientOptions {
  surface: WorkSessionSurface;
  api: WorkSessionApi;
  /** has a call/work in hand here — must not assume the lease expires by itself meanwhile (the server does not release the lease while there is work) */
  busy?: () => boolean;
  now?: () => number;
  timers?: WorkSessionTimers;
  /** retry interval when talking to the server fails, and interval for re-checking the holder during standby */
  retryMs?: number;
}

const browserTimers: WorkSessionTimers = {
  setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** WS messages about the lease (E1.9 `WorkspaceSessionWebSocketAdapter`) */
type LeaseSocketEvent =
  | { type: 'lease.active'; leaseId: string; expiresAt: string }
  | { type: 'lease.revoked'; leaseId: string; reason: 'takeover' | 'auth_revoked' | 'released' }
  | { type: 'lease.expired'; leaseId: string };

function isLeaseEvent(event: unknown): event is LeaseSocketEvent {
  if (!event || typeof event !== 'object') return false;
  const candidate = event as { type?: unknown; leaseId?: unknown };
  return (
    typeof candidate.leaseId === 'string' &&
    (candidate.type === 'lease.active' ||
      candidate.type === 'lease.revoked' ||
      candidate.type === 'lease.expired')
  );
}

/** server WS close code when there is no active lease (E1.9) */
export const LEASE_REQUIRED_CLOSE_CODE = 4409;

export class WorkSessionClient {
  private state: WorkSessionState = { phase: 'idle' };
  private readonly listeners = new Set<(state: WorkSessionState) => void>();
  private readonly timers: WorkSessionTimers;
  private readonly now: () => number;
  private readonly retryMs: number;
  private heartbeatTimer?: unknown;
  private pollTimer?: unknown;
  private retryTimer?: unknown;
  private socket?: WorkSessionSocketSender;
  private expiresAt = 0;
  private autoAcquire = false;
  private stopped = false;
  /** counts request generations — an answer arriving after the state has changed is dropped */
  private generation = 0;

  constructor(private readonly options: WorkSessionClientOptions) {
    this.timers = options.timers ?? browserTimers;
    this.now = options.now ?? Date.now;
    this.retryMs = options.retryMs ?? 20_000;
  }

  current(): WorkSessionState {
    return this.state;
  }

  /** can take new work (holds the lease) — `disabled` lets the caller apply its own old rules */
  ownsWork(): boolean {
    return this.state.phase === 'held';
  }

  leaseId(): string | undefined {
    return this.state.phase === 'held' ? this.state.lease.leaseId : undefined;
  }

  subscribe(listener: (state: WorkSessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * reads flag + holder, then (if `autoAcquire`) requests the lease immediately — `autoAcquire` is the leader tab of this origin
   * (leader election now only reduces load: other tabs in the same browser do not fire a lease request simultaneously)
   */
  async start(options: { autoAcquire: boolean }): Promise<void> {
    this.stopped = false;
    this.autoAcquire = options.autoAcquire;
    if (this.state.phase !== 'idle') return;
    await this.check();
  }

  /** this tab is/is not the origin's leader now — a leader that does not hold the lease while there is no holder → request */
  setAutoAcquire(autoAcquire: boolean): void {
    const changed = this.autoAcquire !== autoAcquire;
    this.autoAcquire = autoAcquire;
    if (
      changed &&
      autoAcquire &&
      this.state.phase === 'standby' &&
      !this.state.holder &&
      !this.state.loss
    ) {
      void this.acquire();
    }
  }

  /** start taking work here when there is no holder (user button or leader) — with a holder → standby with the holder's info */
  async acquire(): Promise<void> {
    if (this.stopped || this.state.phase === 'held') return;
    const generation = this.transition({ phase: 'acquiring' });
    try {
      const lease = await this.options.api.acquire(this.options.surface);
      if (generation !== this.generation) return;
      this.hold(lease);
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof WorkSessionRequestError && error.code === 'WORK_SESSION_HELD') {
        this.enterStandby({ holder: error.holder ?? null });
        return;
      }
      this.fail();
    }
  }

  /**
   * "move here" after the user confirmed — must know the old place's lease (`expectedLeaseId`)
   * work pending at the old place: send no request at all; server rejects: back to standby with the reason, the old place is untouched
   */
  async takeover(): Promise<void> {
    if (this.stopped || this.state.phase !== 'standby') return;
    const standby = this.state;
    const holder = standby.holder;
    if (!holder) {
      await this.acquire();
      return;
    }
    if (holder.busy) {
      this.enterStandby({ holder, loss: standby.loss, rejection: 'busy' });
      return;
    }
    const generation = this.transition({ phase: 'takingOver', holder, loss: standby.loss });
    try {
      const lease = await this.options.api.takeover(this.options.surface, holder.leaseId);
      if (generation !== this.generation) return;
      this.hold(lease);
    } catch (error) {
      if (generation !== this.generation) return;
      const code = error instanceof WorkSessionRequestError ? error.code : undefined;
      if (code === 'WORK_SESSION_BUSY') {
        this.enterStandby({
          holder: { ...holder, ...(error as WorkSessionRequestError).holder, busy: true },
          loss: standby.loss,
          rejection: 'busy',
        });
        return;
      }
      if (code === 'WORK_SESSION_CHANGED') {
        // the holder changed meanwhile — re-read so the user sees the current holder before confirming again
        await this.refresh({ rejection: 'changed', loss: standby.loss });
        return;
      }
      this.enterStandby({ holder, loss: standby.loss, rejection: 'failed' });
    }
  }

  /** re-read the current holder during standby (the "check again" button and the automatic round) */
  async refresh(
    extra: { rejection?: WorkSessionRejection; loss?: WorkSessionLoss } = {},
  ): Promise<void> {
    if (this.stopped) return;
    if (
      this.state.phase !== 'standby' &&
      this.state.phase !== 'takingOver' &&
      this.state.phase !== 'error'
    ) {
      return;
    }
    const loss =
      extra.loss ??
      (this.state.phase === 'standby' || this.state.phase === 'error'
        ? this.state.loss
        : undefined);
    const generation = this.generation;
    try {
      const status = await this.options.api.status();
      if (generation !== this.generation || this.stopped) return;
      this.enterStandby({ holder: status.holder, loss, rejection: extra.rejection });
    } catch {
      if (generation !== this.generation) return;
      this.fail(loss);
    }
  }

  /** bind the WS connected with this lease's `leaseId` — heartbeat is sent over this socket */
  attachSocket(socket: WorkSessionSocketSender): () => void {
    this.socket = socket;
    return () => {
      if (this.socket === socket) this.socket = undefined;
    };
  }

  /** message from the WS — returns true when it is a lease message (the caller need not handle it further) */
  handleSocketEvent(event: unknown): boolean {
    if (!isLeaseEvent(event)) return false;
    if (this.state.phase !== 'held' || this.state.lease.leaseId !== event.leaseId) return true;
    if (event.type === 'lease.active') {
      const expiresAt = Date.parse(event.expiresAt);
      if (Number.isFinite(expiresAt)) this.expiresAt = expiresAt;
      return true;
    }
    this.lose(event.type === 'lease.expired' ? 'expired' : event.reason);
    return true;
  }

  /** WS closed — 4409 = the server no longer accepts this lease (expired/moved) */
  handleSocketClosed(code?: number): void {
    this.socket = undefined;
    if (code === LEASE_REQUIRED_CLOSE_CODE && this.state.phase === 'held') this.lose('expired');
  }

  /** Release an idle controller after its phone disappears. The server guards in-flight work. */
  async releaseIdle(): Promise<boolean> {
    const leaseId = this.leaseId();
    if (!leaseId || this.options.busy?.()) return false;
    try {
      await this.options.api.release(leaseId);
    } catch (error) {
      if (!(error instanceof WorkSessionRequestError && error.code === 'WORK_SESSION_CHANGED')) {
        // Let the server sweep this lease when idle. It keeps the lease while work is in hand.
        if (this.leaseId() === leaseId) this.socket = undefined;
        return false;
      }
    }
    if (this.leaseId() === leaseId) this.lose('released');
    return true;
  }

  /** page close: release the lease so somewhere else can take over immediately (best effort — if it fails it expires by itself in 60 seconds) */
  releaseOnExit(): void {
    if (this.state.phase !== 'held') return;
    if (this.options.busy?.()) return;
    const leaseId = this.state.lease.leaseId;
    this.stop();
    void this.options.api.release(leaseId, { keepalive: true }).catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.clearTimers();
    this.socket = undefined;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async check(): Promise<void> {
    const generation = this.transition({ phase: 'checking' });
    try {
      const status = await this.options.api.status();
      if (generation !== this.generation) return;
      if (this.autoAcquire && !status.holder) {
        await this.acquire();
        return;
      }
      this.enterStandby({ holder: status.holder });
    } catch {
      if (generation !== this.generation) return;
      this.fail();
    }
  }

  private hold(lease: WorkSessionLease): void {
    this.expiresAt = Date.parse(lease.expiresAt);
    this.transition({ phase: 'held', lease });
    this.heartbeatTimer = this.timers.setInterval(
      () => this.beat(),
      Math.max(1, lease.heartbeatSeconds) * 1_000,
    );
  }

  /** one heartbeat round + self-check whether the lease passed its age while idle (WS dropped longer than the TTL) */
  private beat(): void {
    if (this.state.phase !== 'held') return;
    const leaseId = this.state.lease.leaseId;
    if (this.now() >= this.expiresAt && !this.options.busy?.()) {
      this.lose('expired');
      return;
    }
    this.socket?.send({ type: 'lease:heartbeat', leaseId });
  }

  /** lost the lease: stop taking new work immediately, then read the current holder to show the move page */
  private lose(loss: WorkSessionLoss): void {
    this.socket = undefined;
    this.transition({ phase: 'standby', holder: null, loss });
    void this.refresh({ loss });
  }

  private enterStandby(state: {
    holder: WorkSessionHolder | null;
    loss?: WorkSessionLoss;
    rejection?: WorkSessionRejection;
  }): void {
    this.transition({ phase: 'standby', ...stripUndefined(state) });
    // the old holder may have finished work or dropped — check periodically; the move button enables itself when moving is possible
    this.pollTimer = this.timers.setInterval(() => void this.refresh(), this.retryMs);
  }

  private fail(loss?: WorkSessionLoss): void {
    this.transition(loss ? { phase: 'error', loss } : { phase: 'error' });
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = undefined;
      if (this.state.phase !== 'error' || this.stopped) return;
      void this.check();
    }, this.retryMs);
  }

  private transition(next: WorkSessionState): number {
    this.clearTimers();
    this.generation += 1;
    this.state = next;
    for (const listener of this.listeners) listener(next);
    return this.generation;
  }

  private clearTimers(): void {
    if (this.heartbeatTimer !== undefined) this.timers.clearInterval(this.heartbeatTimer);
    if (this.pollTimer !== undefined) this.timers.clearInterval(this.pollTimer);
    if (this.retryTimer !== undefined) this.timers.clearTimeout(this.retryTimer);
    this.heartbeatTimer = undefined;
    this.pollTimer = undefined;
    this.retryTimer = undefined;
  }
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * E1.12 (#486): client ของ work-session lease (E1.9 #483) สำหรับ Workspace และ dphone
 *
 * Authority: E1.3 #459, Phase Contract E1.8 #464, ADR-026 ข้อ 2 และข้อ 4
 *
 * - server เป็นผู้ตัดสินจุดรับงานเดียวต่อ agent ต่อ tenant — client แค่ขอ/ต่ออายุ/ย้าย และหยุดรับงานเมื่อเสีย lease
 * - ลำดับบังคับ: ได้ lease ก่อน แล้วจึงต่อ WS ของ routing (แนบ `leaseId`) และ register SIP
 * - heartbeat ทาง WS (`lease:heartbeat`) ทุก `heartbeatSeconds` (20 วินาที); lease ไม่หมดระหว่างมีงาน (server)
 * - `lease.revoked` / `lease.expired` / WS ปิด 4409 = หยุดรับงานใหม่ทันที; สายที่คุยอยู่ไม่ถูกตัด (ADR-026 ข้อ 4)
 *   การถอน SIP register เป็นหน้าที่ของผู้เรียก เมื่อ `ownsWork` เป็นเท็จและไม่มีสายในมือ
 * - "ย้ายมาที่นี่" = takeover ที่ผู้ใช้ยืนยันแล้ว พร้อม `expectedLeaseId`; ถูกปฏิเสธ (มีงานค้าง/lease เปลี่ยน)
 *   ไม่แตะอะไรของที่เดิม — ทั้งสายและ WS ของที่เดิมอยู่ครบ
 * - tenant ที่ปิด `workSession.lease.enforced` → `disabled`: ใช้ leader election เลือก working tab เหมือนเดิม
 *   แต่ตั้งแต่ E1.10 (#551) SIP credential ออกให้เฉพาะผู้ถือ lease จึง **ไม่มี SIP** ในสถานะนี้ (#569)
 */

export type WorkSessionSurface = 'workspace' | 'dphone' | 'embedded';
export type WorkSessionHolderSurface = WorkSessionSurface;

export interface WorkSessionHolder {
  leaseId: string;
  surface: WorkSessionHolderSurface;
  hostOrigin: string | null;
  acquiredAt: string;
  /** มีสายหรือ wrap-up อยู่ — ย้ายไม่ได้จนกว่างานจบ */
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
  enforced: boolean;
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
  /** E1.14: host origin ที่ iframe ล็อกไว้ — ส่งไปกับ surface `embedded` ให้ server ตรวจกับ allowlist ซ้ำ */
  hostOrigin?: string;
  /** E1.14: fetch ที่แนบ token เอง (ดู `AgentWorkspaceApiOptions.authorizedFetch`) */
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
      // API ที่ยังไม่มี endpoint นี้ / ไม่ใช่ agent ใน DB / role อื่น → ไม่มี lease ให้บังคับจากฝั่งนี้
      // (server ยังบังคับเองที่ WS ด้วย 4409 เมื่อ tenant เปิด flag) — 5xx/เครือข่ายล่มโยนให้ลองใหม่
      if (result.status === 403 || result.status === 404) return { enforced: false, holder: null };
      if (result.status !== 200) throw failure(result);
      const body = (result.body ?? {}) as { enforced?: unknown; holder?: unknown };
      if (typeof body.enforced !== 'boolean') return { enforced: false, holder: null };
      return { enforced: body.enforced, holder: parseHolder(body.holder) ?? null };
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

/** เหตุที่ที่นี่เสีย lease — แสดงให้ผู้ใช้รู้ว่าทำไมหยุดรับงาน */
export type WorkSessionLoss = 'takeover' | 'auth_revoked' | 'released' | 'expired';
/** takeover ถูกปฏิเสธ — ไม่มีอะไรเปลี่ยนทั้งที่นี่และที่เดิม */
export type WorkSessionRejection = 'busy' | 'changed' | 'failed';

export type WorkSessionState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  /** tenant ไม่บังคับ lease — ใช้พฤติกรรมเดิม */
  | { phase: 'disabled' }
  | { phase: 'acquiring' }
  | { phase: 'held'; lease: WorkSessionLease }
  /** ไม่ได้ถือ lease: ดูได้อย่างเดียว — มีผู้ถือที่อื่นหรือยังไม่ได้เริ่ม */
  | {
      phase: 'standby';
      holder: WorkSessionHolder | null;
      loss?: WorkSessionLoss;
      rejection?: WorkSessionRejection;
    }
  | { phase: 'takingOver'; holder: WorkSessionHolder; loss?: WorkSessionLoss }
  /** คุยกับ server ไม่สำเร็จ — ลองใหม่อัตโนมัติ */
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
  /** มีสาย/งานในมือที่นี่ — ห้ามถือว่า lease หมดอายุเองระหว่างนี้ (server ไม่ปล่อย lease ระหว่างมีงาน) */
  busy?: () => boolean;
  now?: () => number;
  timers?: WorkSessionTimers;
  /** ช่วงลองใหม่เมื่อคุยกับ server ไม่สำเร็จ และช่วงตรวจผู้ถือใหม่ระหว่าง standby */
  retryMs?: number;
}

const browserTimers: WorkSessionTimers = {
  setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** ข้อความจาก WS ที่เกี่ยวกับ lease (E1.9 `WorkspaceSessionWebSocketAdapter`) */
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

/** WS close code ของ server เมื่อไม่มี lease ที่ active (E1.9) */
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
  /** นับรุ่นของคำขอ — คำตอบที่มาหลังสถานะเปลี่ยนไปแล้วถูกทิ้ง */
  private generation = 0;

  constructor(private readonly options: WorkSessionClientOptions) {
    this.timers = options.timers ?? browserTimers;
    this.now = options.now ?? Date.now;
    this.retryMs = options.retryMs ?? 20_000;
  }

  current(): WorkSessionState {
    return this.state;
  }

  /** รับงานใหม่ได้ (ถือ lease อยู่) — `disabled` ให้ผู้เรียกใช้กติกาเดิมเอง */
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
   * อ่าน flag + ผู้ถือ แล้ว (ถ้า `autoAcquire`) ขอ lease ทันที — `autoAcquire` คือแท็บ leader ของ origin นี้
   * (leader election เหลือหน้าที่ลดภาระ: แท็บอื่นใน browser เดียวกันไม่ยิงขอ lease พร้อมกัน)
   */
  async start(options: { autoAcquire: boolean }): Promise<void> {
    this.stopped = false;
    this.autoAcquire = options.autoAcquire;
    if (this.state.phase !== 'idle') return;
    await this.check();
  }

  /** แท็บนี้เป็น/ไม่เป็น leader ของ origin แล้ว — เป็น leader ที่ยังไม่ถือ lease และไม่มีผู้ถือ → ขอ */
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

  /** เริ่มรับงานที่นี่เมื่อไม่มีผู้ถือ (ปุ่มของผู้ใช้หรือ leader) — มีผู้ถือ → standby พร้อมข้อมูลผู้ถือ */
  async acquire(): Promise<void> {
    if (this.stopped || this.state.phase === 'disabled' || this.state.phase === 'held') return;
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
   * "ย้ายมาที่นี่" หลังผู้ใช้ยืนยันแล้ว — ต้องรู้ lease ของที่เดิม (`expectedLeaseId`)
   * มีงานค้างที่เดิม: ไม่ส่งคำขอเลย; server ปฏิเสธ: กลับ standby พร้อมเหตุผล ที่เดิมไม่ถูกแตะ
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
        // ผู้ถือเปลี่ยนระหว่างนั้น — อ่านใหม่ ให้ผู้ใช้เห็นผู้ถือปัจจุบันก่อนยืนยันอีกครั้ง
        await this.refresh({ rejection: 'changed', loss: standby.loss });
        return;
      }
      this.enterStandby({ holder, loss: standby.loss, rejection: 'failed' });
    }
  }

  /** อ่านผู้ถือปัจจุบันใหม่ระหว่าง standby (ปุ่ม "ตรวจอีกครั้ง" และรอบอัตโนมัติ) */
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
      if (!status.enforced) {
        this.transition({ phase: 'disabled' });
        return;
      }
      this.enterStandby({ holder: status.holder, loss, rejection: extra.rejection });
    } catch {
      if (generation !== this.generation) return;
      this.fail(loss);
    }
  }

  /** ผูก WS ที่ต่อด้วย `leaseId` ของ lease นี้ — heartbeat ส่งผ่าน socket นี้ */
  attachSocket(socket: WorkSessionSocketSender): () => void {
    this.socket = socket;
    return () => {
      if (this.socket === socket) this.socket = undefined;
    };
  }

  /** ข้อความจาก WS — คืน true เมื่อเป็นข้อความของ lease (ผู้เรียกไม่ต้องจัดการต่อ) */
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

  /** WS ปิด — 4409 = server ไม่รับ lease นี้แล้ว (หมดอายุ/ถูกย้าย) */
  handleSocketClosed(code?: number): void {
    this.socket = undefined;
    if (code === LEASE_REQUIRED_CLOSE_CODE && this.state.phase === 'held') this.lose('expired');
  }

  /** ปิดหน้า: ปล่อย lease ให้ที่อื่นรับงานต่อได้ทันที (best effort — ไม่สำเร็จก็หมดอายุเองใน 60 วินาที) */
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
      if (!status.enforced) {
        this.transition({ phase: 'disabled' });
        return;
      }
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

  /** heartbeat รอบหนึ่ง + ตรวจเองว่า lease เลยอายุตอนว่างหรือยัง (WS หลุดนานเกิน TTL) */
  private beat(): void {
    if (this.state.phase !== 'held') return;
    const leaseId = this.state.lease.leaseId;
    if (this.now() >= this.expiresAt && !this.options.busy?.()) {
      this.lose('expired');
      return;
    }
    this.socket?.send({ type: 'lease:heartbeat', leaseId });
  }

  /** เสีย lease: หยุดรับงานใหม่ทันที แล้วอ่านผู้ถือปัจจุบันเพื่อแสดงหน้าย้าย */
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
    // ผู้ถือเดิมอาจจบงานหรือหลุดไป — ตรวจเป็นรอบ ปุ่มย้ายจะเปิดเองเมื่อย้ายได้
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

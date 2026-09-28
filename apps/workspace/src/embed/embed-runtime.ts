/**
 * E1.14 (#488): ตัวประสานของ dphone ที่ถูกฝัง ระหว่างงานสาย (`WorkspaceApp variant="embedded"`) กับ host
 *
 * - screen-pop: เมื่อมีสายเข้า/รับสาย ขอ payload จาก server (origin มาจาก lease, ลดระดับตาม Governance)
 *   แล้วส่งให้ host เฉพาะเมื่อ `hostOrigin` ที่ server ตอบตรงกับ origin ที่ iframe ล็อกไว้
 * - activity: จบ wrap-up → เข้าคิว `ActivityOutbox` (ส่งซ้ำจน ack, idempotent ด้วย interactionId)
 * - click-to-call: `dphone.call` จาก host แค่กรอกเบอร์ (ตอบ `prefilled`); agent กดโทรเองจึงเรียก server
 * - ข้อความถึง host ไม่มี token และไม่มีข้อมูลเกินที่ server ส่งมา
 */
import type {
  ActivityMessage,
  CallRequestMessage,
  CallResultMessage,
  DphoneToHostMessage,
  ScreenPopSetting,
} from '@d-contact/dphone-embed';
import type { WorkspaceCallEvent } from '../workspace-app.js';

export interface EmbedRuntimeDeps {
  apiBaseUrl: string;
  hostOrigin: string;
  screenPopLevel: ScreenPopSetting;
  /** fetch ที่แนบ token เอง (`EmbeddedAuth.fetch`) */
  authorizedFetch(url: string, init: RequestInit): Promise<Response>;
  send(message: DphoneToHostMessage): boolean;
  enqueueActivity(message: ActivityMessage): void;
  requestId(): string;
  now(): Date;
}

export type PrefillState =
  | { phase: 'idle' }
  | { phase: 'prefilled'; request: CallRequestMessage }
  | { phase: 'dialing'; request: CallRequestMessage }
  | { phase: 'result'; request: CallRequestMessage; result: CallResultMessage };

export class EmbedRuntime {
  private leaseId: string | undefined;
  /** สายที่มาถึงก่อนได้ lease — ขอ screen-pop เมื่อได้ lease */
  private pendingScreenPop: string | undefined;
  private prefill: PrefillState = { phase: 'idle' };
  private readonly listeners = new Set<(state: PrefillState) => void>();

  constructor(private readonly deps: EmbedRuntimeDeps) {}

  get state(): PrefillState {
    return this.prefill;
  }

  subscribe(listener: (state: PrefillState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setLease(leaseId: string | undefined) {
    this.leaseId = leaseId;
    if (leaseId && this.pendingScreenPop) {
      const interactionId = this.pendingScreenPop;
      this.pendingScreenPop = undefined;
      void this.screenPop(interactionId);
    }
  }

  private setPrefill(state: PrefillState) {
    this.prefill = state;
    for (const listener of this.listeners) listener(state);
  }

  private result(
    request: CallRequestMessage,
    status: CallResultMessage['status'],
    reasonCode?: string,
  ): CallResultMessage {
    return {
      v: 1,
      type: 'dphone.call.result',
      requestId: request.requestId,
      status,
      blocked: status === 'blocked' || status === 'rate_limited',
      ...(reasonCode ? { reasonCode } : {}),
    };
  }

  /** `dphone.call` จาก host (ผ่าน HostChannel แล้ว) — กรอกเบอร์เท่านั้น ไม่โทร */
  prefillFromHost(request: CallRequestMessage) {
    if (!this.leaseId) {
      this.deps.send(this.result(request, 'unavailable', 'NOT_SIGNED_IN'));
      return;
    }
    if (this.prefill.phase === 'dialing') {
      this.deps.send(this.result(request, 'unavailable', 'BUSY'));
      return;
    }
    // คำขอเดิมที่ยังรออยู่ถูกแทนที่ → แจ้ง host ว่ายกเลิก
    if (this.prefill.phase === 'prefilled') {
      this.deps.send(this.result(this.prefill.request, 'cancelled', 'REPLACED'));
    }
    this.setPrefill({ phase: 'prefilled', request });
    this.deps.send(this.result(request, 'prefilled'));
  }

  cancel() {
    if (this.prefill.phase !== 'prefilled' && this.prefill.phase !== 'result') return;
    if (this.prefill.phase === 'prefilled') {
      this.deps.send(this.result(this.prefill.request, 'cancelled', 'AGENT_CANCELLED'));
    }
    this.setPrefill({ phase: 'idle' });
  }

  /** agent กดโทร — server ตัดสินด้วย Contact Governance */
  async dial(): Promise<void> {
    if (this.prefill.phase !== 'prefilled' || !this.leaseId) return;
    const { request } = this.prefill;
    this.setPrefill({ phase: 'dialing', request });
    let result: CallResultMessage;
    try {
      const response = await this.deps.authorizedFetch(
        `${this.deps.apiBaseUrl.replace(/\/$/, '')}/api/v1/workspace/agent/click-to-call`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-work-session-lease-id': this.leaseId,
          },
          body: JSON.stringify({ requestId: request.requestId, number: request.number }),
        },
      );
      const body = (await response.json().catch(() => undefined)) as
        { status?: string; hostOrigin?: string; message?: CallResultMessage } | undefined;
      result =
        response.ok && body?.message && body.hostOrigin === this.deps.hostOrigin
          ? body.message
          : this.result(request, 'unavailable', 'SERVER_UNAVAILABLE');
    } catch {
      result = this.result(request, 'unavailable', 'SERVER_UNAVAILABLE');
    }
    this.deps.send(result);
    this.setPrefill({ phase: 'result', request, result });
  }

  onCallEvent(event: WorkspaceCallEvent) {
    if (event.type === 'wrapup.completed') {
      this.deps.enqueueActivity(this.activity(event));
      return;
    }
    void this.screenPop(event.interaction.id);
  }

  private async screenPop(interactionId: string) {
    if (this.deps.screenPopLevel === 'off') return;
    if (!this.leaseId) {
      this.pendingScreenPop = interactionId;
      return;
    }
    try {
      const response = await this.deps.authorizedFetch(
        `${this.deps.apiBaseUrl.replace(/\/$/, '')}/api/v1/workspace/agent/screen-pop`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-work-session-lease-id': this.leaseId },
          body: JSON.stringify({ interactionId, requestId: this.deps.requestId() }),
        },
      );
      if (!response.ok) return;
      const body = (await response.json()) as {
        status?: string;
        hostOrigin?: string;
        message?: DphoneToHostMessage;
      };
      // origin ที่ server ผูกกับ lease ต้องตรงกับ host ที่ iframe ล็อกไว้ ไม่อย่างนั้นไม่ส่ง
      if (body.status === 'sent' && body.message && body.hostOrigin === this.deps.hostOrigin) {
        this.deps.send(body.message);
      }
    } catch {
      // screen-pop เป็นความสะดวกของ host — ล้มแล้วไม่กระทบสาย
    }
  }

  private activity(
    event: Extract<WorkspaceCallEvent, { type: 'wrapup.completed' }>,
  ): ActivityMessage {
    const { interaction } = event;
    const endedAt = interaction.endedAt ?? this.deps.now().toISOString();
    const startedAt = interaction.answeredAt ?? endedAt;
    const durationSeconds = Math.max(
      0,
      Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1_000),
    );
    return {
      v: 1,
      type: 'dphone.activity',
      requestId: this.deps.requestId(),
      interactionId: interaction.id,
      direction: 'INBOUND',
      startedAt,
      endedAt,
      durationSeconds,
      disposition: event.disposition,
      ...(interaction.queue
        ? { queue: { id: interaction.queue.id, name: interaction.queue.name } }
        : {}),
    };
  }
}

/**
 * E1.14 (#488): coordinator between the embedded dphone's call work (`WorkspaceApp variant="embedded"`) and the host
 *
 * - screen-pop: on an incoming/answered call, request the payload from the server (origin comes from the lease, level lowered by Governance)
 *   then send it to the host only when the server's `hostOrigin` matches the origin the iframe is locked to
 * - activity: wrap-up finished → enqueue in `ActivityOutbox` (resent until ack, idempotent by interactionId)
 * - click-to-call: `dphone.call` from the host only fills in the number (answers `prefilled`); the agent presses call themselves, which calls the server
 * - messages to the host carry no token and no data beyond what the server sent
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
  /** fetch that attaches the token itself (`EmbeddedAuth.fetch`) */
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
  /** a call that arrived before the lease was obtained — request screen-pop once the lease is obtained */
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

  /** `dphone.call` from the host (already through HostChannel) — fills in the number only, does not dial */
  prefillFromHost(request: CallRequestMessage) {
    if (!this.leaseId) {
      this.deps.send(this.result(request, 'unavailable', 'NOT_SIGNED_IN'));
      return;
    }
    if (this.prefill.phase === 'dialing') {
      this.deps.send(this.result(request, 'unavailable', 'BUSY'));
      return;
    }
    // the earlier pending request is replaced → tell the host it was cancelled
    if (this.prefill.phase === 'prefilled') {
      this.deps.send(this.result(this.prefill.request, 'cancelled', 'REPLACED'));
    }
    this.setPrefill({ phase: 'prefilled', request });
    this.deps.send(this.result(request, 'prefilled'));
  }

  async cancel(): Promise<void> {
    if (this.prefill.phase !== 'prefilled' && this.prefill.phase !== 'result') return;
    if (this.prefill.phase === 'prefilled') {
      this.deps.send(this.result(this.prefill.request, 'cancelled', 'AGENT_CANCELLED'));
    }
    if (
      this.prefill.phase === 'result' &&
      this.prefill.result.status === 'dialing' &&
      this.leaseId
    ) {
      const { request } = this.prefill;
      let cancelled = false;
      try {
        const response = await this.deps.authorizedFetch(
          `${this.deps.apiBaseUrl.replace(/\/$/, '')}/api/v1/workspace/agent/click-to-call/cancel`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-work-session-lease-id': this.leaseId,
            },
            body: JSON.stringify({ requestId: request.requestId }),
          },
        );
        const body = (await response.json().catch(() => undefined)) as
          { hostOrigin?: string; result?: { status?: string } } | undefined;
        cancelled =
          response.ok &&
          body?.hostOrigin === this.deps.hostOrigin &&
          body.result?.status === 'cancelled';
      } catch {
        // the real result must still come from the server/ESL; the host gets a reconciling state with no PII.
      }
      this.deps.send(
        this.result(
          request,
          cancelled ? 'cancelled' : 'unavailable',
          cancelled ? 'AGENT_CANCELLED' : 'VOICE_CANCEL_RECONCILING',
        ),
      );
    }
    this.setPrefill({ phase: 'idle' });
  }

  /** the agent presses call — the server decides with Contact Governance */
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
      // the origin the server bound to the lease must match the host the iframe is locked to, otherwise do not send
      if (body.status === 'sent' && body.message && body.hostOrigin === this.deps.hostOrigin) {
        this.deps.send(body.message);
      }
    } catch {
      // screen-pop is a convenience for the host — failing does not affect the call
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
      direction: interaction.direction,
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

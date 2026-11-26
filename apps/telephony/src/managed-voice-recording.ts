import type { KafkaEventEnvelope } from '@d-contact/kafka';
import type { TelephonyCallEvent } from '@d-contact/shared';
import { normalizeFreeSwitchEvent, type FreeSwitchEvent } from './freeswitch-normalizer.js';
import { normalizeManagedVoiceEvent } from './managed-voice-events.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Cap on calls remembered as already recording, guarding against the customer-leg hangup never arriving (e.g. ESL dropped) */
const maxBegun = 1_000;

/**
 * #991: events of a leg with `dcontact_offer_id` (after the adapter sets it on the customer leg before bridge, they come this way too)
 * The recording cycle always runs even when the managed runtime throws, because if the customer hangs up while the database hiccups
 * the recording row would have no endedAt and the archive retry would never pick it up. The lifecycle checks tenant/interaction/queue itself from the DB
 */
export async function routeManagedOfferLegWithRecording<T>(
  source: FreeSwitchEvent,
  route: () => Promise<T>,
  record: (source: FreeSwitchEvent, tenantId: string) => Promise<void>,
): Promise<T> {
  const tenantId = source.variable_dcontact_tenant_id;
  try {
    return await route();
  } finally {
    if (typeof tenantId === 'string' && uuidPattern.test(tenantId)) await record(source, tenantId);
  }
}

/**
 * #991: managed calls do not go through Kafka/the legacy router, so they do not go through `publishTelephonyCallEvent` either.
 * This decides which ESL events of a managed call start/close the existing recording cycle
 * (recording-lifecycle checks `queue.recordingEnabled` itself, so it need not be known here)
 * - start: a CHANNEL_BRIDGE that binds the customer call to the Agent that managed sent an offer to (with offer/agent/B-leg all present)
 * - close: CHANNEL_HANGUP_COMPLETE of the customer leg (the Unique-ID is the customer call, not the Agent leg)
 * It uses the same envelope as legacy (`call.answered`/`call.hangup`) so the lifecycle need not split into two paths
 */
export class ManagedRecordingTrigger {
  /** Calls already told to start: a repeated bridge (FreeSWITCH sends it from both legs) need not hit the DB again */
  private readonly begun = new Set<string>();

  constructor(
    private readonly options: {
      telephonyNodeId: string;
      eventId(): string;
      now(): string;
    },
  ) {}

  /** Returns the envelope to send into the recording cycle, or undefined if this event is irrelevant */
  decide(
    source: FreeSwitchEvent,
    tenantId: string,
  ): KafkaEventEnvelope<TelephonyCallEvent> | undefined {
    let managed;
    try {
      managed = normalizeManagedVoiceEvent(source, tenantId, this.options.telephonyNodeId);
    } catch {
      return undefined;
    }
    if (!managed) return undefined;
    if (managed.type === 'call.bridge') {
      // A managed bridge must be the customer leg with the Agent: Bridge-A-Unique-ID matches the customer call the runtime holds
      if (source['Bridge-A-Unique-ID'] !== managed.callUuid) return undefined;
      if (this.begun.has(managed.callUuid)) return undefined;
      const event = this.envelope(source, tenantId, 'call.answered');
      if (event) {
        if (this.begun.size >= maxBegun) this.begun.delete(this.begun.values().next().value!);
        this.begun.add(managed.callUuid);
      }
      return event;
    }
    if (managed.type === 'call.hangup' && managed.offerId === undefined) {
      if (source['Unique-ID'] !== managed.callUuid) return undefined;
      this.begun.delete(managed.callUuid);
      return this.envelope(source, tenantId, 'call.hangup');
    }
    return undefined;
  }

  private envelope(
    source: FreeSwitchEvent,
    tenantId: string,
    type: 'call.answered' | 'call.hangup',
  ) {
    const event = normalizeFreeSwitchEvent(
      {
        ...source,
        'Event-Name': type === 'call.answered' ? 'CHANNEL_BRIDGE' : 'CHANNEL_HANGUP_COMPLETE',
      },
      {
        telephonyNodeId: this.options.telephonyNodeId,
        resolveTenantId: () => tenantId,
        resolveTenantIdForCall: () => tenantId,
        eventId: this.options.eventId,
        now: this.options.now,
      },
    );
    return event.type === type ? event : undefined;
  }

  get pending(): number {
    return this.begun.size;
  }
}

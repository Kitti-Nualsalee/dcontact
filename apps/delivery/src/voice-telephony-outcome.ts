import type {
  VoiceOriginateOutcomeInput,
  VoiceOriginateOutcomeResult,
} from './voice-originate-outcome.js';

export interface VoiceTelephonyEvent {
  eventId: string;
  type: string;
  tenantId: string;
  occurredAt: string;
  correlationId: string;
  payload: { deliveryId?: string; providerRequestKey?: string };
}

export interface VoiceOutcomeRecorder {
  record(input: VoiceOriginateOutcomeInput): Promise<VoiceOriginateOutcomeResult>;
}

/** แปลงเฉพาะ outbound events ที่มี opaque delivery metadata; สาย inbound ถูกข้ามทั้งหมด. */
export class VoiceTelephonyOutcomeHandler {
  constructor(private readonly recorder: VoiceOutcomeRecorder) {}

  async handle(event: VoiceTelephonyEvent): Promise<VoiceOriginateOutcomeResult | 'IGNORED'> {
    const deliveryId = event.payload.deliveryId;
    const providerRequestKey = event.payload.providerRequestKey;
    if (!deliveryId || !providerRequestKey) return 'IGNORED';
    const outcome = outcomeFor(event);
    if (!outcome) return 'IGNORED';
    return this.recorder.record({
      tenantId: event.tenantId,
      deliveryId,
      correlationId: event.correlationId,
      outcomeRef: `voice:${event.eventId}`,
      occurredAt: event.occurredAt,
      outcome,
    });
  }
}

function outcomeFor(event: VoiceTelephonyEvent) {
  if (event.type === 'call.created') return 'PROVIDER_ACCEPTED' as const;
  if (event.type === 'call.answered') return 'DELIVERED' as const;
  if (event.type === 'call.hangup') return 'DELIVERY_FAILED' as const;
  return undefined;
}

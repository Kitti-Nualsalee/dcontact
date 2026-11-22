import type { KafkaEventEnvelope } from '@d-contact/kafka';
import type { TelephonyCallEvent } from '@d-contact/shared';
import { normalizeFreeSwitchEvent, type FreeSwitchEvent } from './freeswitch-normalizer.js';
import { normalizeManagedVoiceEvent } from './managed-voice-events.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** เพดานของสายที่จำว่าเริ่มบันทึกแล้ว กันกรณี hangup ของขาลูกค้าไม่มาถึง (เช่น ESL หลุด) */
const maxBegun = 1_000;

/**
 * #991: event ของขาที่มี `dcontact_offer_id` (หลัง adapter ตั้งบนขาลูกค้าก่อน bridge ก็เข้าทางนี้ด้วย)
 * วงจรบันทึกเสียงรันเสมอแม้ managed runtime throw เพราะถ้าลูกค้าวางตอนฐานข้อมูลสะดุด
 * แถว recording จะไม่มี endedAt และ retry archive จะไม่หยิบมาอีก lifecycle ตรวจ tenant/interaction/คิวเองจาก DB
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
 * #991: สาย managed ไม่ผ่าน Kafka/legacy router จึงไม่ผ่าน `publishTelephonyCallEvent` ด้วย
 * ตัวนี้ตัดสินว่า event ESL ของสาย managed ตัวไหนเริ่ม/ปิดวงจรบันทึกเสียงเดิม
 * (recording-lifecycle เช็ก `queue.recordingEnabled` เองจึงไม่ต้องรู้ที่นี่)
 * - เริ่ม: CHANNEL_BRIDGE ที่ผูกสายลูกค้ากับ Agent ที่ managed ส่ง offer ไป (มี offer/agent/B-leg ครบ)
 * - ปิด: CHANNEL_HANGUP_COMPLETE ของขาลูกค้า (Unique-ID เป็นสายลูกค้า ไม่ใช่ขา Agent)
 * ใช้ envelope แบบเดียวกับ legacy (`call.answered`/`call.hangup`) เพื่อให้ lifecycle ไม่ต้องแยกสองทาง
 */
export class ManagedRecordingTrigger {
  /** สายที่สั่งเริ่มแล้ว: bridge ซ้ำ (FreeSWITCH ส่งจากทั้งสองขา) ไม่ต้องเข้า DB อีก */
  private readonly begun = new Set<string>();

  constructor(
    private readonly options: {
      telephonyNodeId: string;
      eventId(): string;
      now(): string;
    },
  ) {}

  /** คืน envelope ที่ต้องส่งเข้าวงจรบันทึกเสียง หรือ undefined ถ้า event นี้ไม่เกี่ยว */
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
      // bridge ของ managed ต้องเป็นขาลูกค้ากับ Agent: Bridge-A-Unique-ID ตรงกับสายลูกค้าที่ runtime ถืออยู่
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

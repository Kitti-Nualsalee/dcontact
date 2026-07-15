import { createProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { randomUUID } from 'crypto';
import { EslClient } from './esl-client';

/**
 * Telephony service — สะพานระหว่าง FreeSWITCH กับส่วนที่เหลือของระบบ
 * หน้าที่: ฟัง FS events → normalize → produce ลง Kafka (dc.fs.events, key = callUuid)
 * Phase 1 จะเพิ่ม: consume dc.telephony.commands (park/bridge), recording, map call → interaction
 */

const WATCHED_EVENTS = [
  'CHANNEL_CREATE',
  'CHANNEL_ANSWER',
  'CHANNEL_BRIDGE',
  'CHANNEL_HANGUP_COMPLETE',
  'CUSTOM',
];

async function main() {
  const producer = await createProducer('dc-telephony');

  const esl = new EslClient({
    host: process.env.FS_ESL_HOST ?? 'localhost',
    port: Number(process.env.FS_ESL_PORT ?? 8021),
    password: process.env.FS_ESL_PASSWORD ?? 'ClueCon',
    events: WATCHED_EVENTS,
    onEvent: (event) => {
      const name = event.getHeader('Event-Name');
      const uuid = event.getHeader('Unique-ID');
      if (!uuid) return; // สนใจเฉพาะ channel events

      // Phase 1: resolve SIP domain → tenant UUID จาก DB (ตอนนี้ใช้ domain เป็น tenant key ไปก่อน)
      const sipDomain =
        event.getHeader('variable_domain_name') ??
        event.getHeader('variable_sip_req_host') ??
        'dcontact.local';

      const envelope = {
        eventId: randomUUID(),
        tenantId: sipDomain,
        occurredAt: new Date().toISOString(),
        eventName: name,
        callUuid: uuid,
        caller: event.getHeader('Caller-Caller-ID-Number'),
        destination: event.getHeader('Caller-Destination-Number'),
        direction: event.getHeader('Call-Direction'),
      };

      console.log(
        `[telephony] ${name} uuid=${uuid} ${envelope.caller ?? '?'} -> ${envelope.destination ?? '?'}`,
      );
      producer.send(KAFKA_TOPICS.FS_EVENTS, uuid, envelope).catch((err) => {
        console.error('[telephony] kafka produce failed:', err.message);
      });
    },
  });

  esl.start();

  process.on('SIGINT', async () => {
    esl.stop();
    await producer.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[telephony] fatal:', err);
  process.exit(1);
});

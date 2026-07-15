import { createConsumer } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';

/**
 * ACD / Routing engine — สมองของระบบ (skeleton, ทำจริง Phase 1)
 *
 * แผนงาน Phase 1:
 * 1. consume dc.fs.events: CHANNEL_CREATE จาก trunk → สร้าง Interaction, เข้า queue
 * 2. agent state machine ใน Redis (state store): available → reserved → busy → acw
 * 3. assignment loop: longest-idle agent ที่ skill ตรง → produce คำสั่ง bridge ลง dc.telephony.commands
 * 4. timeout/requeue เมื่อ agent ไม่รับใน N วินาที
 * 5. produce domain events ลง dc.interaction.events (source of truth ของ reporting/billing)
 * channel อื่น (chat/social/email) ใช้ queue + assignment เดียวกัน — ต่างแค่ concurrency
 */

async function main() {
  await createConsumer('dc-router', [KAFKA_TOPICS.FS_EVENTS], (message) => {
    const event = message.value as { eventName?: string; callUuid?: string };
    // TODO(Phase 1): routing decision ตาม queue/skill/agent availability
    console.log(
      `[router] ${event.eventName} key=${message.key} tenant=${message.tenantId} uuid=${event.callUuid}`,
    );
  });
}

main().catch((err) => {
  console.error('[router] fatal:', err);
  process.exit(1);
});

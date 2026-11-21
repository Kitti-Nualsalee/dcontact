import type { Prisma } from '@d-contact/db';

/**
 * #967: บันทึก Agent และทีมที่รับสายจริง ต้องเรียกใน transaction เดียวกับที่เปลี่ยนสายเป็น ACTIVE
 * สิทธิ์ฟังเสียงของ Supervisor ใช้ทีมจากแถวนี้ ไม่เดาจากทีมปัจจุบันของ Agent หรือคิว
 * แถวแรกของ Interaction ชนะ การรับซ้ำไม่เปลี่ยนทีม
 */
export async function recordVoiceHandlingAttribution(
  transaction: Prisma.TransactionClient,
  input: { tenantId: string; interactionId: string; agentId: string; sourceEventId: string },
): Promise<void> {
  await transaction.$executeRaw`INSERT INTO voice_interaction_handling_attributions
      (tenant_id, interaction_id, agent_id, team_id, accepted_at, source_event_id)
    SELECT i.tenant_id, i.id, u.id, u.team_id, COALESCE(i.answered_at, CURRENT_TIMESTAMP), ${input.sourceEventId}
    FROM interactions i
    JOIN users u ON u.tenant_id = i.tenant_id AND u.id = ${input.agentId}::uuid
    WHERE i.tenant_id = ${input.tenantId}::uuid AND i.id = ${input.interactionId}::uuid
    ON CONFLICT (tenant_id, interaction_id) DO NOTHING`;
}

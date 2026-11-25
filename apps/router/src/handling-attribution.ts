import type { Prisma } from '@d-contact/db';

/**
 * #967: records the Agent and team that actually took the call; must be called in the same transaction that changes the call to ACTIVE.
 * The Supervisor listening permission uses the team from this row, not a guess from the current team of the Agent or the queue.
 * The first row of an Interaction wins; a repeated answer does not change the team, and nothing is written when the Agent is not the current owner of the call.
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
      AND i.agent_id = u.id
    ON CONFLICT (tenant_id, interaction_id) DO NOTHING`;
}

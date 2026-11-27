import { Prisma } from '@d-contact/db';

/**
 * A Supervisor reaches a call through the team that actually handled it (the Router's
 * `voice_interaction_handling_attributions`), compared with the Supervisor's current team and
 * active account on every request - the same rule as #967 playback and #971 evaluation. The
 * agent's current team is not used: moving an agent must not move their past calls between teams.
 * A call with no handling evidence is reachable by no Supervisor.
 */
export async function supervisesHandlingTeam(
  transaction: Prisma.TransactionClient,
  actor: { roles: readonly string[]; userId: string; tenantId: string },
  interactionId: string,
): Promise<boolean> {
  if (!actor.roles.includes('supervisor')) return false;
  const [row] = await transaction.$queryRaw<{ allowed: boolean }[]>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM users u
      JOIN voice_interaction_handling_attributions a
        ON a.tenant_id = u.tenant_id AND a.team_id = u.team_id
      WHERE u.tenant_id = ${actor.tenantId}::uuid AND u.id = ${actor.userId}::uuid
        AND u.role = 'SUPERVISOR' AND u.is_active
        AND a.interaction_id = ${interactionId}::uuid
    ) AS allowed`);
  return row?.allowed === true;
}

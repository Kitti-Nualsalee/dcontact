import type { Prisma } from '@prisma/client';

/** Known Team writers call this before the existing domain row/fence; the trigger still covers raw/indirect writers in every way */
export async function lockTeamReferences(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  teams: readonly (string | null | undefined)[],
): Promise<void> {
  const ids = teams.filter(
    (id): id is string =>
      typeof id === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id),
  );
  // the SQL is fixed; tenant/array values are bound as parameters and never composed into SQL text
  await transaction.$executeRawUnsafe(
    'SELECT public.dc_team_reference_lock($1::uuid,$2::uuid[],false)',
    tenantId,
    ids,
  );
}

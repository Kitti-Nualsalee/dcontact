import type { Prisma } from '@prisma/client';

/** Known Team writers เรียกก่อน domain row/fence เดิม; trigger ยังครอบ raw/indirect writers ทุกทาง */
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
  // SQL คงที่; ค่า tenant/array bind เป็น parameters ไม่ประกอบเป็น SQL text
  await transaction.$executeRawUnsafe(
    'SELECT public.dc_team_reference_lock($1::uuid,$2::uuid[],false)',
    tenantId,
    ids,
  );
}

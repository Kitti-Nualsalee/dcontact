import { Prisma } from '@d-contact/db';

export async function managedRuntimeReady(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  nodeId: string | null = null,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<
    { ready: boolean }[]
  >`SELECT dc_voice_managed_runtime_ready(${tenantId}::uuid,${nodeId}::text) AS ready`;
  return rows[0]?.ready === true;
}

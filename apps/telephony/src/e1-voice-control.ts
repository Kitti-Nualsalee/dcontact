import { type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { VoiceRolloutControlPlane } from '@d-contact/delivery';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function runE1VoiceControl(
  database: PrismaClient,
  args: string[],
  tenantId: string,
  nodeId: string,
  control = new VoiceRolloutControlPlane(database),
  now = new Date(),
) {
  if (!uuid.test(tenantId) || nodeId !== 'e1-uat-sandbox')
    throw new Error('E1_SANDBOX_SCOPE_REQUIRED');
  const [command, actorRef, agentUserId, targetIdentityId] = args;
  if (
    !['status', 'idle', 'prepare', 'on', 'off'].includes(command) ||
    args.length !==
      (command === 'status' || command === 'idle' ? 1 : command === 'prepare' ? 4 : 2) ||
    (!['status', 'idle'].includes(command) &&
      !/^operator:[A-Za-z0-9_-]{1,64}$/.test(actorRef ?? '')) ||
    (command === 'prepare' && (!uuid.test(agentUserId ?? '') || !uuid.test(targetIdentityId ?? '')))
  )
    throw new Error('E1_VOICE_CONTROL_ARGUMENTS_INVALID');
  const tenant = await database.tenant.findUnique({
    where: { id: tenantId },
    select: { slug: true, lifecycleStatus: true },
  });
  if (tenant?.slug !== 'dcontact-uat' || tenant.lifecycleStatus !== 'ACTIVE')
    throw new Error('E1_UAT_TEST_TENANT_REQUIRED');
  const scope = { tenantId, telephonyNodeId: nodeId };
  if (command === 'idle') {
    const busy = await withTenantDatabaseTransaction(database, tenantId, (transaction) =>
      transaction.interaction.count({
        where: { tenantId, channel: 'VOICE', state: { in: ['ASSIGNED', 'ACTIVE', 'WRAPUP'] } },
      }),
    );
    if (busy > 0) throw new Error('E1_VOICE_WORK_STILL_ACTIVE');
    return { tenantId, nodeId, status: 'IDLE' };
  }
  const current = await withTenantDatabaseTransaction(database, tenantId, (transaction) =>
    transaction.dlVoiceScopeGate.findFirst({ where: scope }),
  );
  if (command === 'status')
    return {
      tenantId,
      nodeId,
      businessState: current?.businessState ?? 'ABSENT',
      technicalSwitchOn: current?.technicalSwitchOn ?? false,
      killed: current?.killed ?? false,
      runtimeEnabled: process.env.OUTBOUND_VOICE_DELIVERY_ENABLED === 'true',
    };
  if (command === 'off') {
    if (current) await control.setTechnicalSwitch(scope, false, actorRef, now);
    return { tenantId, nodeId, status: 'DISABLED' };
  }
  if (current?.killed || current?.businessState === 'CAPPED_PILOT')
    throw new Error('E1_SANDBOX_SCOPE_REQUIRED');
  if (command === 'on') {
    if (process.env.OUTBOUND_VOICE_DELIVERY_ENABLED === 'true')
      throw new Error('E1_VOICE_RUNTIME_ALREADY_ENABLED');
    if (
      current?.businessState !== 'SANDBOX' ||
      !current.capPerMinute ||
      !current.capPerDay ||
      !current.agentCapPerMinute ||
      !current.agentCapPerDay
    )
      throw new Error('E1_SANDBOX_NOT_PREPARED');
    await control.setTechnicalSwitch(scope, true, actorRef, now);
    return { tenantId, nodeId, status: 'SANDBOX_ENABLED' };
  }
  const valid = await withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    const [agent, target] = await Promise.all([
      transaction.user.findFirst({
        where: { tenantId, id: agentUserId, role: 'AGENT', isActive: true },
        select: { extension: true },
      }),
      transaction.contactIdentity.findFirst({
        where: { tenantId, id: targetIdentityId, type: 'PHONE' },
        select: { value: true },
      }),
    ]);
    return (
      /^1[0-9]{3}$/.test(agent?.extension ?? '') &&
      /^1[0-9]{3}$/.test(target?.value.trim() ?? '') &&
      agent?.extension !== target?.value.trim()
    );
  });
  if (!valid) throw new Error('E1_INTERNAL_SYNTHETIC_TARGET_REQUIRED');
  let gate = await control.ensureScope(scope);
  await control.setTechnicalSwitch(scope, false, actorRef, now);
  if (gate.businessState === 'DISABLED')
    gate = await control.advanceState(scope, 'DRY_RUN', actorRef, now);
  if (gate.businessState === 'DRY_RUN')
    gate = await control.advanceState(scope, 'SANDBOX', actorRef, now);
  if (gate.businessState !== 'SANDBOX') throw new Error('E1_SANDBOX_SCOPE_REQUIRED');
  await control.configureCaps(
    scope,
    { tenantPerMinute: 2, tenantPerDay: 10, agentPerMinute: 1, agentPerDay: 10 },
    actorRef,
    now,
  );
  await control.allow({
    ...scope,
    agentUserId,
    targetIdentityId,
    validFrom: now,
    validUntil: new Date(now.getTime() + 30 * 60_000),
    actorRef,
  });
  return { tenantId, nodeId, status: 'PREPARED_DEFAULT_OFF', allowlistMinutes: 30 };
}

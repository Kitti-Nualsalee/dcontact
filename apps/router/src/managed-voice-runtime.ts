import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type {
  ManagedVoiceDirectCommand,
  ManagedVoiceDirectPort,
  ManagedVoiceEvent,
  ManagedVoiceResult,
} from './managed-voice-contracts.js';

interface ManagedCall {
  interactionId: string;
  state: ManagedVoiceResult['status'];
  agentId: string | null;
  queueId: string;
  callUuid: string;
  telephonyNodeId: string;
  firstQueueEnteredAt: Date;
  preanswerDeadline: Date;
  currentOfferId: string | null;
  terminalReason: string | null;
}

interface ManagedOffer {
  id: string;
  interactionId: string;
  agentId: string;
  agentExtension: string;
  blegUuid: string;
  expiresAt: Date;
  outcome: string;
}

export class ManagedVoiceRuntime {
  constructor(
    private readonly database: PrismaClient,
    private readonly directPort: ManagedVoiceDirectPort,
    private readonly dispatchDatabase: PrismaClient,
  ) {}

  async heartbeat(tenantId: string, telephonyNodeId: string, ttlMs = 15000): Promise<void> {
    if (!this.directPort.readback) throw new Error('MANAGED_VOICE_READBACK_NOT_WIRED');
    if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60000)
      throw new Error('invalid readiness TTL');
    await withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.$executeRaw`INSERT INTO voice_managed_runtime_readiness(tenant_id,telephony_node_id,version,direct_wired,expires_at)
        VALUES(${tenantId}::uuid,${telephonyNodeId},1,true,clock_timestamp()+${ttlMs}*interval '1 millisecond')
        ON CONFLICT(tenant_id,telephony_node_id) DO UPDATE SET version=1,direct_wired=true,
        expires_at=excluded.expires_at,updated_at=clock_timestamp()`;
    });
  }

  async handle(event: ManagedVoiceEvent): Promise<ManagedVoiceResult | null> {
    const result = await this.transaction(event.tenantId, async (transaction) => {
      let call = await this.findCall(
        transaction,
        event.tenantId,
        event.callUuid,
        event.telephonyNodeId,
      );
      if (!call && event.type === 'call.created') call = await this.createCall(transaction, event);
      if (!call) return null;
      const now = await this.now(transaction);
      if (event.type === 'call.created') {
        await this.advance(transaction, event.tenantId, call, now);
      } else if (event.type === 'call.answered' || event.type === 'call.bridge') {
        await this.answer(transaction, event, call, now);
      } else {
        await this.hangup(transaction, event, call, now);
      }
      const latest = await transaction.interaction.findFirstOrThrow({
        where: { tenantId: event.tenantId, id: call.interactionId },
        select: { id: true, state: true, agentId: true },
      });
      return {
        interactionId: latest.id,
        status: latest.state,
        ...(latest.agentId ? { agentId: latest.agentId } : {}),
      };
    });
    return result;
  }

  async tick(tenantId: string, telephonyNodeId: string): Promise<void> {
    await this.transaction(tenantId, async (transaction) => {
      const calls = await transaction.$queryRaw<
        ManagedCall[]
      >`SELECT i.id AS "interactionId",i.state,i.agent_id AS "agentId",i.queue_id AS "queueId",
        c.call_uuid AS "callUuid",c.telephony_node_id AS "telephonyNodeId",c.first_queue_entered_at AS "firstQueueEnteredAt",
        c.preanswer_deadline AS "preanswerDeadline",c.current_offer_id AS "currentOfferId",c.terminal_reason AS "terminalReason"
        FROM voice_managed_calls c JOIN interactions i ON i.tenant_id=c.tenant_id AND i.id=c.interaction_id
        WHERE c.tenant_id=${tenantId}::uuid AND c.telephony_node_id=${telephonyNodeId} AND i.state IN ('QUEUED','ASSIGNED')
        ORDER BY c.first_queue_entered_at,i.id FOR UPDATE OF i,c SKIP LOCKED`;
      for (const call of calls)
        await this.advance(transaction, tenantId, call, await this.now(transaction));
    });
  }

  async flushCommands(tenantId: string, telephonyNodeId: string): Promise<void> {
    const calls = await withTenantDatabaseTransaction(
      this.database,
      tenantId,
      (transaction) => transaction.$queryRaw<{ callUuid: string }[]>`
      SELECT c.call_uuid AS "callUuid" FROM voice_managed_calls c JOIN interactions i ON i.tenant_id=c.tenant_id AND i.id=c.interaction_id
      WHERE c.tenant_id=${tenantId}::uuid AND c.telephony_node_id=${telephonyNodeId} AND (i.state='ACTIVE' OR EXISTS(
        SELECT 1 FROM voice_managed_commands cmd WHERE cmd.tenant_id=c.tenant_id AND cmd.interaction_id=c.interaction_id AND cmd.status='PENDING'))
      ORDER BY c.first_queue_entered_at,c.interaction_id`,
    );
    let next = 0;
    const pump = async () => {
      while (next < calls.length) {
        const call = calls[next++];
        await this.reconcileActive(tenantId, telephonyNodeId, call.callUuid);
        await this.dispatch(tenantId, telephonyNodeId, call.callUuid);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, calls.length) }, pump));
  }

  private async reconcileActive(tenantId: string, nodeId: string, callUuid: string) {
    if (!this.directPort.readback) return;
    const [snapshot] = await withTenantDatabaseTransaction(
      this.database,
      tenantId,
      (transaction) => transaction.$queryRaw<{ payload: ManagedVoiceDirectCommand }[]>`
      SELECT cmd.payload FROM voice_managed_calls c JOIN interactions i ON i.tenant_id=c.tenant_id AND i.id=c.interaction_id
      JOIN voice_managed_commands cmd ON cmd.tenant_id=c.tenant_id AND cmd.interaction_id=c.interaction_id AND cmd.offer_id=c.current_offer_id AND cmd.command_type='call.bridge'
      WHERE c.tenant_id=${tenantId}::uuid AND c.telephony_node_id=${nodeId} AND c.call_uuid=${callUuid} AND i.state='ACTIVE' LIMIT 1`,
    );
    if (!snapshot) return;
    let actual: { callerExists: boolean; blegExists: boolean };
    try {
      actual = await this.directPort.readback(snapshot.payload);
    } catch {
      return;
    }
    if (actual.callerExists && actual.blegExists) return;
    await this.transaction(tenantId, async (transaction) => {
      const call = await this.findCall(transaction, tenantId, callUuid, nodeId);
      if (!call || call.state !== 'ACTIVE' || call.currentOfferId !== snapshot.payload.offerId)
        return;
      await this.hangup(
        transaction,
        { tenantId, telephonyNodeId: nodeId, callUuid, type: 'call.hangup' },
        call,
        await this.now(transaction),
      );
    });
  }

  private async transaction<Result>(
    tenantId: string,
    work: (transaction: Prisma.TransactionClient) => Promise<Result>,
  ) {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('dc:v1:voice-config:'||${tenantId},0))`;
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('dc:v1:managed-runtime:'||${tenantId},0))`;
      await transaction.$executeRaw`SELECT set_config('app.voice_managed_runtime','1',true)`;
      return work(transaction);
    });
  }

  private async now(transaction: Prisma.TransactionClient): Promise<Date> {
    const [row] = await transaction.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    return row.now;
  }

  private async findCall(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    callUuid: string,
    nodeId: string,
    lock = true,
  ): Promise<ManagedCall | null> {
    const [call] = await transaction.$queryRaw<
      ManagedCall[]
    >`SELECT i.id AS "interactionId",i.state,i.agent_id AS "agentId",i.queue_id AS "queueId",
      c.call_uuid AS "callUuid",c.telephony_node_id AS "telephonyNodeId",c.first_queue_entered_at AS "firstQueueEnteredAt",
      c.preanswer_deadline AS "preanswerDeadline",c.current_offer_id AS "currentOfferId",c.terminal_reason AS "terminalReason"
      FROM voice_managed_calls c JOIN interactions i ON i.tenant_id=c.tenant_id AND i.id=c.interaction_id
      WHERE c.tenant_id=${tenantId}::uuid AND c.call_uuid=${callUuid} AND c.telephony_node_id=${nodeId} ${lock ? Prisma.sql`FOR UPDATE OF i,c` : Prisma.empty}`;
    return call ?? null;
  }

  private async createCall(transaction: Prisma.TransactionClient, event: ManagedVoiceEvent) {
    if (!event.destination) return null;
    const [route] = await transaction.$queryRaw<
      { id: string }[]
    >`SELECT q.id FROM voice_destinations d
      JOIN queues q ON q.tenant_id=d.tenant_id AND q.id=d.queue_id
      JOIN voice_managed_queue_policies p ON p.tenant_id=q.tenant_id AND p.queue_id=q.id
      WHERE d.tenant_id=${event.tenantId}::uuid AND d.destination=${event.destination} AND d.is_active AND q.is_active
      AND d.entry_mode='DIRECT_QUEUE' AND q.voice_config_version=1 AND p.version=1
      AND NOT q.recording_enabled AND NOT q.auto_qm_enabled AND q.transcription_mode='OFF' AND q.routing_strategy='LONGEST_AVAILABLE_IDLE'
      AND p.offer_timeout_sec=20 AND p.max_total_preanswer_sec=60 AND p.terminal_action='HANGUP' AND p.skip_timed_out_agent
      AND EXISTS(SELECT 1 FROM queue_skills WHERE tenant_id=q.tenant_id AND queue_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM queue_skills qs JOIN skills s ON s.tenant_id=qs.tenant_id AND s.id=qs.skill_id
        WHERE qs.tenant_id=q.tenant_id AND qs.queue_id=q.id AND (s.team_id IS DISTINCT FROM q.team_id OR qs.min_level NOT BETWEEN 1 AND 5))
      AND EXISTS(SELECT 1 FROM tenant_voice_provisioning_policies policy CROSS JOIN LATERAL jsonb_array_elements(policy.destination_pool) item
        WHERE policy.tenant_id=q.tenant_id AND item->>'destinationId'=d.id::text AND item->>'telephonyNodeId'=${event.telephonyNodeId})`;
    if (!route) return null;
    const interaction = await transaction.interaction.create({
      data: {
        tenantId: event.tenantId,
        queueId: route.id,
        channel: 'VOICE',
        direction: 'INBOUND',
        state: 'QUEUED',
        externalId: event.callUuid,
        metadata: {
          vendor: 'freeswitch',
          telephonyNodeId: event.telephonyNodeId,
          caller: event.caller ?? '',
          destination: event.destination,
        },
      },
    });
    await transaction.$executeRaw`INSERT INTO voice_managed_calls(tenant_id,interaction_id,telephony_node_id,call_uuid,first_queue_entered_at,preanswer_deadline)
      SELECT ${event.tenantId}::uuid,${interaction.id}::uuid,${event.telephonyNodeId},${event.callUuid},entered,entered+interval '60 seconds' FROM (SELECT clock_timestamp() AS entered) stamp`;
    await this.log(transaction, event.tenantId, interaction.id, 'interaction.created', {
      channel: 'VOICE',
      state: 'QUEUED',
    });
    return this.findCall(transaction, event.tenantId, event.callUuid, event.telephonyNodeId);
  }

  private async offer(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    offerId: string | null,
  ) {
    if (!offerId) return null;
    const [offer] = await transaction.$queryRaw<
      ManagedOffer[]
    >`SELECT id,interaction_id AS "interactionId",agent_id AS "agentId",agent_extension AS "agentExtension",bleg_uuid AS "blegUuid",expires_at AS "expiresAt",outcome
      FROM voice_managed_offers WHERE tenant_id=${tenantId}::uuid AND id=${offerId}::uuid`;
    return offer ?? null;
  }

  private async advance(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    call: ManagedCall,
    now: Date,
  ) {
    if (call.state !== 'QUEUED' && call.state !== 'ASSIGNED') return;
    if (now >= call.preanswerDeadline) {
      await this.terminal(transaction, tenantId, call, 'PREANSWER_DEADLINE_EXCEEDED', now);
      return;
    }
    const current = await this.offer(transaction, tenantId, call.currentOfferId);
    if (current?.outcome === 'PENDING') {
      if (now < current.expiresAt) return;
      await transaction.$executeRaw`UPDATE voice_managed_offers SET outcome='TIMED_OUT' WHERE tenant_id=${tenantId}::uuid AND id=${current.id}::uuid AND outcome='PENDING'`;
      await this.intent(transaction, tenantId, call, current, 'offer.cancel', 'OFFER_TIMEOUT');
      await transaction.interaction.updateMany({
        where: { tenantId, id: call.interactionId, state: 'ASSIGNED', agentId: current.agentId },
        data: { state: 'QUEUED', agentId: null, assignedAt: null, offerExpiresAt: null },
      });
      call.state = 'QUEUED';
      call.agentId = null;
      await this.log(transaction, tenantId, call.interactionId, 'interaction.offer_timed_out', {
        offerId: current.id,
        agentId: current.agentId,
      });
    }
    const [agent] = await transaction.$queryRaw<
      { id: string; extension: string }[]
    >`SELECT u.id,u.extension FROM users u
      JOIN queues q ON q.tenant_id=u.tenant_id AND q.id=${call.queueId}::uuid AND q.team_id=u.team_id
      JOIN LATERAL(SELECT state FROM agent_state_logs s WHERE s.tenant_id=u.tenant_id AND s.user_id=u.id ORDER BY started_at DESC,id DESC LIMIT 1) latest ON true
      WHERE u.tenant_id=${tenantId}::uuid AND u.role='AGENT' AND u.is_active AND u.extension IS NOT NULL AND latest.state='AVAILABLE'
      AND NOT EXISTS(SELECT 1 FROM interactions i WHERE i.tenant_id=u.tenant_id AND i.agent_id=u.id AND i.state IN ('ASSIGNED','ACTIVE','WRAPUP'))
      AND NOT EXISTS(SELECT 1 FROM voice_managed_commands cmd JOIN voice_managed_offers old_offer ON old_offer.tenant_id=cmd.tenant_id AND old_offer.id=cmd.offer_id
        WHERE cmd.tenant_id=u.tenant_id AND old_offer.agent_id=u.id AND cmd.status='PENDING' AND cmd.command_type IN ('offer.cancel','call.hangup'))
      AND NOT EXISTS(SELECT 1 FROM voice_managed_offers o WHERE o.tenant_id=u.tenant_id AND o.interaction_id=${call.interactionId}::uuid AND o.agent_id=u.id AND o.outcome IN ('TIMED_OUT','CANCELLED'))
      AND NOT EXISTS(SELECT 1 FROM queue_skills qs LEFT JOIN agent_skills a ON a.tenant_id=qs.tenant_id AND a.skill_id=qs.skill_id AND a.user_id=u.id
        WHERE qs.tenant_id=u.tenant_id AND qs.queue_id=q.id AND (a.user_id IS NULL OR a.level<qs.min_level))
      ORDER BY (SELECT max(started_at) FROM agent_state_logs s WHERE s.tenant_id=u.tenant_id AND s.user_id=u.id),u.id FOR UPDATE OF u SKIP LOCKED LIMIT 1`;
    if (!agent) return;
    const assignedAt = await this.now(transaction);
    if (assignedAt >= call.preanswerDeadline)
      return this.terminal(transaction, tenantId, call, 'PREANSWER_DEADLINE_EXCEEDED', assignedAt);
    const offer: ManagedOffer = {
      id: randomUUID(),
      interactionId: call.interactionId,
      agentId: agent.id,
      agentExtension: agent.extension,
      blegUuid: randomUUID(),
      expiresAt: new Date(Math.min(assignedAt.getTime() + 20000, call.preanswerDeadline.getTime())),
      outcome: 'PENDING',
    };
    await transaction.$executeRaw`INSERT INTO voice_managed_offers(tenant_id,id,interaction_id,agent_id,agent_extension,bleg_uuid,assigned_at,expires_at,outcome)
      VALUES(${tenantId}::uuid,${offer.id}::uuid,${call.interactionId}::uuid,${agent.id}::uuid,${agent.extension},${offer.blegUuid}::uuid,${assignedAt},${offer.expiresAt},'PENDING')`;
    await transaction.$executeRaw`UPDATE voice_managed_calls SET current_offer_id=${offer.id}::uuid WHERE tenant_id=${tenantId}::uuid AND interaction_id=${call.interactionId}::uuid`;
    await transaction.interaction.updateMany({
      where: { tenantId, id: call.interactionId, state: 'QUEUED' },
      data: { state: 'ASSIGNED', agentId: agent.id, assignedAt, offerExpiresAt: offer.expiresAt },
    });
    await transaction.agentStateLog.create({
      data: { tenantId, userId: agent.id, state: 'RESERVED', reason: call.interactionId },
    });
    await this.log(transaction, tenantId, call.interactionId, 'interaction.assigned', {
      agentId: agent.id,
      offerId: offer.id,
      expiresAt: offer.expiresAt.toISOString(),
    });
    await this.intent(transaction, tenantId, call, offer, 'offer.create');
  }

  private async answer(
    transaction: Prisma.TransactionClient,
    event: ManagedVoiceEvent,
    call: ManagedCall,
    now: Date,
  ) {
    const offer = await this.offer(transaction, event.tenantId, event.offerId ?? null);
    if (
      !offer ||
      offer.interactionId !== call.interactionId ||
      offer.agentId !== event.agentId ||
      offer.blegUuid !== event.blegUuid
    )
      return;
    if (
      offer.id !== call.currentOfferId ||
      (event.type === 'call.bridge' && call.state !== 'ACTIVE')
    ) {
      await this.intent(transaction, event.tenantId, call, offer, 'offer.cancel', 'LATE_ANSWER');
      return;
    }
    if (call.state === 'ACTIVE' && offer.outcome === 'ANSWERED') return;
    if (
      call.state !== 'ASSIGNED' ||
      offer.outcome !== 'PENDING' ||
      now >= offer.expiresAt ||
      now >= call.preanswerDeadline
    ) {
      await this.intent(transaction, event.tenantId, call, offer, 'offer.cancel', 'LATE_ANSWER');
      await this.advance(transaction, event.tenantId, call, now);
      return;
    }
    const updated =
      await transaction.$executeRaw`UPDATE interactions SET state='ACTIVE',answered_at=clock_timestamp(),offer_expires_at=NULL
      WHERE tenant_id=${event.tenantId}::uuid AND id=${call.interactionId}::uuid AND state='ASSIGNED' AND agent_id=${offer.agentId}::uuid
      AND clock_timestamp()<${offer.expiresAt} AND clock_timestamp()<${call.preanswerDeadline}`;
    if (!updated)
      return this.advance(transaction, event.tenantId, call, await this.now(transaction));
    await transaction.$executeRaw`UPDATE voice_managed_offers SET outcome='ANSWERED' WHERE tenant_id=${event.tenantId}::uuid AND id=${offer.id}::uuid AND outcome='PENDING'`;
    await transaction.agentStateLog.create({
      data: {
        tenantId: event.tenantId,
        userId: offer.agentId,
        state: 'BUSY',
        reason: call.interactionId,
      },
    });
    await this.log(transaction, event.tenantId, call.interactionId, 'interaction.answered', {
      agentId: offer.agentId,
      offerId: offer.id,
    });
    await this.intent(transaction, event.tenantId, call, offer, 'call.bridge');
  }

  private async hangup(
    transaction: Prisma.TransactionClient,
    event: ManagedVoiceEvent,
    call: ManagedCall,
    now: Date,
  ) {
    const current = await this.offer(transaction, event.tenantId, call.currentOfferId);
    if (event.offerId) {
      const previous = await this.offer(transaction, event.tenantId, event.offerId);
      if (!previous || previous.agentId !== event.agentId || previous.blegUuid !== event.blegUuid)
        return;
      if (
        previous.id !== call.currentOfferId ||
        previous.outcome === 'TIMED_OUT' ||
        previous.outcome === 'CANCELLED'
      )
        return;
      if (call.state === 'ASSIGNED') {
        await this.advance(transaction, event.tenantId, call, now);
        return;
      }
    }
    if (call.state === 'QUEUED' || call.state === 'ASSIGNED')
      return this.terminal(transaction, event.tenantId, call, 'CALLER_CANCELLED', now);
    if (call.state !== 'ACTIVE' || !current) return;
    const changed = await transaction.interaction.updateMany({
      where: { tenantId: event.tenantId, id: call.interactionId, state: 'ACTIVE' },
      data: { state: 'WRAPUP', endedAt: now },
    });
    if (!changed.count) return;
    await transaction.$executeRaw`UPDATE voice_managed_offers SET outcome='ENDED' WHERE tenant_id=${event.tenantId}::uuid AND id=${current.id}::uuid`;
    await transaction.agentStateLog.create({
      data: {
        tenantId: event.tenantId,
        userId: current.agentId,
        state: 'ACW',
        reason: call.interactionId,
      },
    });
    await this.intent(transaction, event.tenantId, call, current, 'call.hangup', 'AGENT_HANGUP');
    await transaction.$executeRaw`UPDATE voice_managed_calls SET terminal_reason='AGENT_HANGUP' WHERE tenant_id=${event.tenantId}::uuid AND interaction_id=${call.interactionId}::uuid`;
    await this.log(
      transaction,
      event.tenantId,
      call.interactionId,
      'interaction.managed_terminal',
      { reason: 'AGENT_HANGUP' },
    );
    await this.log(transaction, event.tenantId, call.interactionId, 'interaction.ended', {
      agentId: current.agentId,
    });
  }

  private async terminal(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    call: ManagedCall,
    reason: string,
    now: Date,
  ) {
    const changed = await transaction.interaction.updateMany({
      where: { tenantId, id: call.interactionId, state: { in: ['QUEUED', 'ASSIGNED'] } },
      data: { state: 'ABANDONED', endedAt: now, offerExpiresAt: null, requeueAt: null },
    });
    if (!changed.count) return;
    await transaction.$executeRaw`UPDATE voice_managed_calls SET terminal_reason=${reason} WHERE tenant_id=${tenantId}::uuid AND interaction_id=${call.interactionId}::uuid`;
    const current = await this.offer(transaction, tenantId, call.currentOfferId);
    if (current) {
      await transaction.$executeRaw`UPDATE voice_managed_offers SET outcome='CANCELLED' WHERE tenant_id=${tenantId}::uuid AND id=${current.id}::uuid AND outcome='PENDING'`;
    }
    const offers = await transaction.$queryRaw<
      { id: string }[]
    >`SELECT id FROM voice_managed_offers WHERE tenant_id=${tenantId}::uuid AND interaction_id=${call.interactionId}::uuid`;
    for (const previous of offers) {
      const offer = await this.offer(transaction, tenantId, previous.id);
      await this.intent(transaction, tenantId, call, offer, 'offer.cancel', reason);
    }
    await this.intent(transaction, tenantId, call, current, 'call.hangup', reason);
    await this.log(transaction, tenantId, call.interactionId, 'interaction.managed_terminal', {
      reason,
    });
    await this.log(transaction, tenantId, call.interactionId, 'interaction.abandoned', { reason });
  }

  private async release(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    interactionId: string,
    agentId: string,
  ) {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('dc:v1:voice-config:'||${tenantId},0))`;
    await transaction.$queryRaw`SELECT id FROM users WHERE tenant_id=${tenantId}::uuid AND id=${agentId}::uuid FOR UPDATE`;
    const latest = await transaction.agentStateLog.findFirst({
      where: { tenantId, userId: agentId },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    });
    if (latest?.state !== 'RESERVED' || latest.reason !== interactionId) return;
    if (
      await transaction.interaction.findFirst({
        where: { tenantId, agentId, state: { in: ['ASSIGNED', 'ACTIVE', 'WRAPUP'] } },
        select: { id: true },
      })
    )
      return;
    await transaction.agentStateLog.create({
      data: { tenantId, userId: agentId, state: 'AVAILABLE', reason: interactionId },
    });
  }

  private async log(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    interactionId: string,
    type: string,
    payload: Prisma.InputJsonObject,
  ) {
    await transaction.interactionEvent.create({ data: { tenantId, interactionId, type, payload } });
  }

  private async intent(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    call: ManagedCall,
    offer: ManagedOffer | null,
    type: ManagedVoiceDirectCommand['type'],
    reason?: string,
  ) {
    const [existing] = await transaction.$queryRaw<
      { id: string }[]
    >`SELECT id FROM voice_managed_commands WHERE tenant_id=${tenantId}::uuid
      AND interaction_id=${call.interactionId}::uuid AND offer_id IS NOT DISTINCT FROM ${offer?.id ?? null}::uuid AND command_type=${type}`;
    if (existing) {
      if (type === 'offer.cancel' && reason === 'LATE_ANSWER') {
        await transaction.$executeRaw`UPDATE voice_managed_commands SET status='PENDING',confirmed_at=NULL WHERE tenant_id=${tenantId}::uuid AND id=${existing.id}::uuid AND status='CONFIRMED'`;
      }
      return;
    }
    const command: ManagedVoiceDirectCommand = {
      commandId: randomUUID(),
      tenantId,
      telephonyNodeId: call.telephonyNodeId,
      interactionId: call.interactionId,
      callUuid: call.callUuid,
      offerId: offer?.id ?? null,
      blegUuid: offer?.blegUuid ?? randomUUID(),
      type,
      ...(offer
        ? {
            agentId: offer.agentId,
            agentExtension: offer.agentExtension,
            expiresAt: offer.expiresAt.toISOString(),
          }
        : {}),
      ...(reason ? { reason } : {}),
    };
    await transaction.$executeRaw`INSERT INTO voice_managed_commands(tenant_id,id,interaction_id,telephony_node_id,call_uuid,offer_id,command_type,payload)
      VALUES(${tenantId}::uuid,${command.commandId}::uuid,${call.interactionId}::uuid,${call.telephonyNodeId},${call.callUuid},${offer?.id ?? null}::uuid,${type},${JSON.stringify(command)}::jsonb)`;
  }

  private async dispatch(tenantId: string, nodeId: string, callUuid: string) {
    const commands = await withTenantDatabaseTransaction(
      this.database,
      tenantId,
      (transaction) => transaction.$queryRaw<{ id: string; payload: ManagedVoiceDirectCommand }[]>`
      SELECT id,payload FROM voice_managed_commands WHERE tenant_id=${tenantId}::uuid AND telephony_node_id=${nodeId} AND call_uuid=${callUuid} AND status='PENDING' ORDER BY created_at,id`,
    );
    for (const row of commands) {
      await withTenantDatabaseTransaction(
        this.dispatchDatabase,
        tenantId,
        async (dispatcher) => {
          const [lock] = await dispatcher.$queryRaw<
            { locked: boolean }[]
          >`SELECT pg_try_advisory_xact_lock(hashtextextended('dc:v1:managed-dispatch:'||${tenantId}||':'||${row.payload.callUuid},0)) AS locked`;
          if (!lock.locked) return;
          const [pending] = await dispatcher.$queryRaw<
            { id: string }[]
          >`SELECT id FROM voice_managed_commands WHERE tenant_id=${tenantId}::uuid AND id=${row.id}::uuid AND status='PENDING'`;
          if (!pending) return;
          if (row.payload.type === 'offer.create') {
            const [cleanup] = await dispatcher.$queryRaw<
              { id: string }[]
            >`SELECT id FROM voice_managed_commands WHERE tenant_id=${tenantId}::uuid
          AND interaction_id=${row.payload.interactionId}::uuid AND command_type IN ('offer.cancel','call.hangup') AND status='PENDING' LIMIT 1`;
            if (cleanup) return;
          }
          const call = await this.findCall(
            dispatcher,
            tenantId,
            row.payload.callUuid,
            nodeId,
            false,
          );
          if (!call) return;
          const offer = await this.offer(dispatcher, tenantId, row.payload.offerId);
          const now = await this.now(dispatcher);
          if (
            (row.payload.type === 'offer.create' &&
              (!offer ||
                offer.outcome !== 'PENDING' ||
                call.state !== 'ASSIGNED' ||
                now >= offer.expiresAt ||
                now >= call.preanswerDeadline)) ||
            (row.payload.type === 'call.bridge' &&
              (!offer ||
                offer.outcome !== 'ANSWERED' ||
                call.state !== 'ACTIVE' ||
                offer.id !== call.currentOfferId))
          ) {
            await dispatcher.$executeRaw`UPDATE voice_managed_commands SET status='OBSOLETE' WHERE tenant_id=${tenantId}::uuid AND id=${row.id}::uuid AND status='PENDING'`;
            return;
          }
          let confirmed: boolean;
          try {
            confirmed = (await this.directPort.execute(row.payload)).confirmed;
          } catch (error) {
            const actionRequired =
              error instanceof Error &&
              'code' in error &&
              error.code === 'MANAGED_VOICE_ORIGINATE_OUTCOME_UNKNOWN';
            const lastError = actionRequired
              ? 'MANAGED_VOICE_ORIGINATE_OUTCOME_UNKNOWN'
              : 'DIRECT_PORT_UNCONFIRMED';
            if (actionRequired) {
              const [previous] = await dispatcher.$queryRaw<
                { lastError: string | null }[]
              >`SELECT last_error AS "lastError" FROM voice_managed_commands WHERE tenant_id=${tenantId}::uuid AND id=${row.id}::uuid`;
              if (previous?.lastError !== lastError)
                await this.log(
                  dispatcher,
                  tenantId,
                  row.payload.interactionId,
                  'interaction.managed_reconciliation_required',
                  { reason: lastError, commandId: row.id },
                );
            }
            await dispatcher.$executeRaw`UPDATE voice_managed_commands SET attempts=attempts+1,last_error=${lastError} WHERE tenant_id=${tenantId}::uuid AND id=${row.id}::uuid AND status='PENDING'`;
            return;
          }
          await dispatcher.$executeRaw`UPDATE voice_managed_commands SET attempts=attempts+1,status=${confirmed ? 'CONFIRMED' : 'PENDING'},
            confirmed_at=CASE WHEN ${confirmed} THEN clock_timestamp() ELSE NULL END,last_error=NULL WHERE tenant_id=${tenantId}::uuid AND id=${row.id}::uuid AND status='PENDING'`;
          if (
            confirmed &&
            row.payload.agentId &&
            (row.payload.type === 'offer.cancel' || row.payload.type === 'call.hangup')
          ) {
            await this.release(
              dispatcher,
              tenantId,
              row.payload.interactionId,
              row.payload.agentId,
            );
          }
        },
        { timeout: 120000 },
      );
    }
  }
}

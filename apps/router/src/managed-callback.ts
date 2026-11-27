/**
 * #1061 — the call of an agent-scheduled callback on the managed voice runtime
 *
 * The legs are the inbound ones reversed: the offer leg (B) rings the Agent's D-Phone first, and the
 * `callback.originate` command bridges it to the customer's internal number (the call's A-leg, `callUuid`)
 * once the Agent answers. From there the runtime treats it like an answered inbound call: ACTIVE, team
 * attribution, BUSY, then WRAPUP on hangup. The offer is never moved to another Agent.
 *
 * Runs inside the caller's tenant transaction (apps/api, together with the Dialer's callback update) and takes
 * the same locks as `ManagedVoiceRuntime`, so it never interleaves with a runtime round of the tenant.
 */
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@d-contact/db';
import type { ManagedVoiceDirectCommand } from './managed-voice-contracts.js';

export type ManagedCallbackErrorCode =
  'AGENT_NOT_AVAILABLE' | 'AGENT_EXTENSION_MISSING' | 'VOICE_NOT_READY' | 'INVALID_DESTINATION';

export class ManagedCallbackError extends Error {
  constructor(readonly code: ManagedCallbackErrorCode) {
    super(code);
    this.name = 'ManagedCallbackError';
  }
}

export interface ManagedCallbackInput {
  tenantId: string;
  queueId: string;
  agentId: string;
  contactId: string;
  /** the customer's internal number (`1xxx`) */
  destination: string;
  callbackId: string;
}

export interface ManagedCallbackStarted {
  interactionId: string;
  callUuid: string;
  offerId: string;
  telephonyNodeId: string;
}

const OFFER_MS = 20_000;

export async function startManagedCallback(
  transaction: Prisma.TransactionClient,
  input: ManagedCallbackInput,
): Promise<ManagedCallbackStarted> {
  if (!/^1[0-9]{3}$/.test(input.destination)) throw new ManagedCallbackError('INVALID_DESTINATION');
  const { tenantId } = input;
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('dc:v1:voice-config:'||${tenantId},0))`;
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('dc:v1:managed-runtime:'||${tenantId},0))`;
  await transaction.$executeRaw`SELECT set_config('app.voice_managed_runtime','1',true)`;

  // A node of the tenant whose managed runtime is up; a node serving this queue's numbers first
  const [node] = await transaction.$queryRaw<{ nodeId: string }[]>`
    SELECT item->>'telephonyNodeId' AS "nodeId"
      FROM tenant_voice_provisioning_policies policy
      CROSS JOIN LATERAL jsonb_array_elements(policy.destination_pool) item
      LEFT JOIN voice_destinations d ON d.tenant_id=policy.tenant_id AND d.id::text=item->>'destinationId'
     WHERE policy.tenant_id=${tenantId}::uuid AND item->>'telephonyNodeId' IS NOT NULL
       AND dc_voice_managed_runtime_ready(${tenantId}::uuid, item->>'telephonyNodeId')
     ORDER BY (d.queue_id=${input.queueId}::uuid) DESC NULLS LAST, item->>'telephonyNodeId'
     LIMIT 1`;
  if (!node) throw new ManagedCallbackError('VOICE_NOT_READY');

  // The same conditions as an inbound offer: Ready, no other work (any channel), no cleanup still pending
  const [agent] = await transaction.$queryRaw<{ extension: string | null; state: string | null }[]>`
    SELECT u.extension, latest.state::text AS state FROM users u
      LEFT JOIN LATERAL(SELECT state FROM agent_state_logs s WHERE s.tenant_id=u.tenant_id AND s.user_id=u.id
        ORDER BY started_at DESC,id DESC LIMIT 1) latest ON true
     WHERE u.tenant_id=${tenantId}::uuid AND u.id=${input.agentId}::uuid AND u.role='AGENT' AND u.is_active
     FOR UPDATE OF u`;
  if (!agent || agent.state !== 'AVAILABLE') throw new ManagedCallbackError('AGENT_NOT_AVAILABLE');
  if (!agent.extension || !/^[0-9]{4,6}$/.test(agent.extension))
    throw new ManagedCallbackError('AGENT_EXTENSION_MISSING');
  const [busy] = await transaction.$queryRaw<{ found: number }[]>`
    SELECT 1 AS found WHERE EXISTS(SELECT 1 FROM interactions i WHERE i.tenant_id=${tenantId}::uuid AND i.agent_id=${input.agentId}::uuid
        AND i.state IN ('ASSIGNED','ACTIVE','WRAPUP'))
      OR EXISTS(SELECT 1 FROM voice_managed_commands cmd JOIN voice_managed_offers o ON o.tenant_id=cmd.tenant_id AND o.id=cmd.offer_id
        WHERE cmd.tenant_id=${tenantId}::uuid AND o.agent_id=${input.agentId}::uuid AND cmd.status='PENDING'
          AND cmd.command_type IN ('offer.cancel','call.hangup'))`;
  if (busy) throw new ManagedCallbackError('AGENT_NOT_AVAILABLE');

  const callUuid = randomUUID();
  const [{ now }] = await transaction.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const offerExpiresAt = new Date(now.getTime() + OFFER_MS);
  const interaction = await transaction.interaction.create({
    data: {
      tenantId,
      queueId: input.queueId,
      channel: 'VOICE',
      direction: 'OUTBOUND',
      state: 'ASSIGNED',
      agentId: input.agentId,
      contactId: input.contactId,
      assignedAt: now,
      offerExpiresAt,
      externalId: callUuid,
      metadata: {
        vendor: 'freeswitch',
        telephonyNodeId: node.nodeId,
        source: 'AGENT_CALLBACK',
        callbackId: input.callbackId,
        destination: input.destination,
      },
    },
  });
  await transaction.$executeRaw`INSERT INTO voice_managed_calls(tenant_id,interaction_id,telephony_node_id,call_uuid,first_queue_entered_at,preanswer_deadline,kind,destination)
    VALUES(${tenantId}::uuid,${interaction.id}::uuid,${node.nodeId},${callUuid},${now},${new Date(now.getTime() + 60_000)},'CALLBACK',${input.destination})`;
  const offerId = randomUUID();
  const blegUuid = randomUUID();
  await transaction.$executeRaw`INSERT INTO voice_managed_offers(tenant_id,id,interaction_id,agent_id,agent_extension,bleg_uuid,assigned_at,expires_at,outcome)
    VALUES(${tenantId}::uuid,${offerId}::uuid,${interaction.id}::uuid,${input.agentId}::uuid,${agent.extension},${blegUuid}::uuid,${now},${offerExpiresAt},'PENDING')`;
  await transaction.$executeRaw`UPDATE voice_managed_calls SET current_offer_id=${offerId}::uuid WHERE tenant_id=${tenantId}::uuid AND interaction_id=${interaction.id}::uuid`;
  await transaction.agentStateLog.create({
    data: { tenantId, userId: input.agentId, state: 'RESERVED', reason: interaction.id },
  });
  for (const [type, payload] of [
    [
      'interaction.created',
      { channel: 'VOICE', state: 'ASSIGNED', direction: 'OUTBOUND', source: 'AGENT_CALLBACK' },
    ],
    [
      'interaction.assigned',
      { agentId: input.agentId, offerId, expiresAt: offerExpiresAt.toISOString() },
    ],
  ] as const)
    await transaction.interactionEvent.create({
      data: { tenantId, interactionId: interaction.id, type, payload },
    });
  const command: ManagedVoiceDirectCommand = {
    commandId: randomUUID(),
    tenantId,
    telephonyNodeId: node.nodeId,
    interactionId: interaction.id,
    callUuid,
    offerId,
    blegUuid,
    type: 'callback.originate',
    agentId: input.agentId,
    agentExtension: agent.extension,
    expiresAt: offerExpiresAt.toISOString(),
    destination: input.destination,
  };
  await transaction.$executeRaw`INSERT INTO voice_managed_commands(tenant_id,id,interaction_id,telephony_node_id,call_uuid,offer_id,command_type,payload)
    VALUES(${tenantId}::uuid,${command.commandId}::uuid,${interaction.id}::uuid,${node.nodeId},${callUuid},${offerId}::uuid,'callback.originate',${JSON.stringify(command)}::jsonb)`;
  return { interactionId: interaction.id, callUuid, offerId, telephonyNodeId: node.nodeId };
}

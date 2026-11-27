import type { Prisma } from '@d-contact/db';
import { WEBCHAT_EVENT_CONTENT_TYPE } from './webchat-service.js';
import type { WorkChannel } from './agent-work-metrics.js';

/**
 * #1044 the conversation of a finished work item, for the history pages. The caller has already decided
 * that the requester may read this Interaction (own work, or work their team took — #859, #986);
 * this only reads its messages. A call has no messages and answers an empty list.
 */
export interface WorkTranscriptMessage {
  id: string;
  at: string;
  from: 'visitor' | 'agent' | 'system';
  text?: string;
  event?: string;
}

export const WORK_TRANSCRIPT_LIMIT = 1000;

export interface WorkTranscript {
  interactionId: string;
  channel: WorkChannel;
  /** how the chat ended (CUSTOMER_ENDED | AGENT_ENDED | IDLE_TIMEOUT | CUSTOMER_LEFT); null for a call */
  endReason: string | null;
  /** whether the Agent linked a customer to this work */
  customerLinked: boolean;
  messages: WorkTranscriptMessage[];
}

export async function readWorkTranscript(
  tx: Prisma.TransactionClient,
  tenantId: string,
  interactionId: string,
  channel: WorkChannel,
): Promise<WorkTranscript> {
  const interaction = await tx.interaction.findFirst({
    where: { tenantId, id: interactionId },
    select: { contactId: true },
  });
  const customerLinked = Boolean(interaction?.contactId);
  if (channel !== 'WEBCHAT')
    return { interactionId, channel, endReason: null, customerLinked, messages: [] };
  const session = await tx.webchatSession.findFirst({
    where: { tenantId, interactionId },
    select: { endReason: true },
  });
  const rows = await tx.message.findMany({
    where: { tenantId, interactionId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, createdAt: true, senderType: true, contentType: true, body: true },
    take: WORK_TRANSCRIPT_LIMIT,
  });
  return {
    interactionId,
    channel,
    endReason: session?.endReason ?? null,
    customerLinked,
    messages: rows.map((row) =>
      row.contentType === WEBCHAT_EVENT_CONTENT_TYPE
        ? { id: row.id, at: row.createdAt.toISOString(), from: 'system', event: row.body }
        : {
            id: row.id,
            at: row.createdAt.toISOString(),
            from: row.senderType === 'AGENT' ? 'agent' : 'visitor',
            text: row.body,
          },
    ),
  };
}

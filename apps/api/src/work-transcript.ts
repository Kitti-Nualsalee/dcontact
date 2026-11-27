import type { Prisma } from '@d-contact/db';
import {
  chatEndReasons,
  LINE_OTHER_CONTENT_TYPE,
  lineLabel,
  WEBCHAT_EVENT_CONTENT_TYPE,
} from './webchat-service.js';
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
  /** #1054 a customer's LINE message that is not text: LINE's type (sticker, image, …) */
  other?: string;
}

export const WORK_TRANSCRIPT_LIMIT = 1000;

export interface WorkTranscript {
  interactionId: string;
  channel: WorkChannel;
  /** how the chat ended (CUSTOMER_ENDED | AGENT_ENDED | IDLE_TIMEOUT | CUSTOMER_LEFT); null for a call */
  endReason: string | null;
  /** whether the Agent linked a customer to this work */
  customerLinked: boolean;
  /** the label the Agent saw for the customer (web chat: anonymous label; LINE: name); null for a call */
  visitorLabel: string | null;
  queueName: string | null;
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
    select: { contactId: true, queue: { select: { name: true } } },
  });
  const customerLinked = Boolean(interaction?.contactId);
  const queueName = interaction?.queue?.name ?? null;
  if (channel !== 'WEBCHAT' && channel !== 'LINE')
    return {
      interactionId,
      channel,
      endReason: null,
      customerLinked,
      visitorLabel: null,
      queueName,
      messages: [],
    };
  let endReason: string | null;
  let visitorLabel: string | null;
  if (channel === 'WEBCHAT') {
    const session = await tx.webchatSession.findFirst({
      where: { tenantId, interactionId },
      select: { endReason: true, visitorLabel: true },
    });
    endReason = session?.endReason ?? null;
    visitorLabel = session?.visitorLabel ?? null;
  } else {
    const work = await tx.interaction.findFirst({
      where: { tenantId, id: interactionId },
      select: { conversationId: true },
    });
    const user = work?.conversationId
      ? await tx.lineChatUser.findFirst({
          where: { tenantId, conversationId: work.conversationId },
          select: { displayName: true, lineUserId: true },
        })
      : null;
    endReason = (await chatEndReasons(tx, tenantId, [interactionId])).get(interactionId) ?? null;
    visitorLabel = user ? lineLabel(user) : null;
  }
  const rows = await tx.message.findMany({
    where: { tenantId, interactionId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, createdAt: true, senderType: true, contentType: true, body: true },
    take: WORK_TRANSCRIPT_LIMIT,
  });
  return {
    interactionId,
    channel,
    endReason,
    customerLinked,
    visitorLabel,
    queueName,
    messages: rows.map((row) =>
      row.contentType === WEBCHAT_EVENT_CONTENT_TYPE
        ? { id: row.id, at: row.createdAt.toISOString(), from: 'system', event: row.body }
        : row.contentType === LINE_OTHER_CONTENT_TYPE
          ? { id: row.id, at: row.createdAt.toISOString(), from: 'visitor', other: row.body }
          : {
              id: row.id,
              at: row.createdAt.toISOString(),
              from: row.senderType === 'AGENT' ? 'agent' : 'visitor',
              text: row.body,
            },
    ),
  };
}

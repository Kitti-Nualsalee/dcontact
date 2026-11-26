/**
 * Owner: Delivery/Channels — list of inbound LINE pilot messages for the read-only page on UAT (#566 R2/R3)
 *
 * - reads `dl_line_webhook_inbox` + the payload that ingress encrypted directly (without waiting for a worker) of a single binding
 * - an item has no raw LINE userId/groupId/roomId, replyToken, webhookEventId or the whole payload — the sender is a
 *   short fingerprint and the text comes only from the vault's `readPilotView`
 * - every successful read appends audit `LINE_PILOT_INBOUND_VIEWED` (category WEBHOOK): actor + digest of the ids
 *   returned — no content
 */
import { createHash, randomUUID } from 'node:crypto';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import type { LineAuditRepository } from './line-audit-repository.js';
import type { EncryptedLineWebhookPayloadVault } from './line-webhook-payload-vault.js';

export const LINE_PILOT_INBOUND_MAX_LIMIT = 100;
export const LINE_PILOT_INBOUND_VIEWED = 'LINE_PILOT_INBOUND_VIEWED';
const FINGERPRINT_LENGTH = 12;

export interface LinePilotInboundItem {
  /** internal id of the inbox row (our uuid, not a LINE ID) */
  id: string;
  receivedAt: string;
  eventType: string;
  messageType: string | null;
  text: string | null;
  senderFingerprint: string | null;
  state: string;
}

export interface LinePilotInboundPage {
  items: LinePilotInboundItem[];
  quarantined: number;
  nextCursor: string | null;
}

export class LinePilotInboundCursorError extends Error {
  readonly code = 'INVALID_CURSOR';
}

interface Cursor {
  receivedAt: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeLinePilotCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.receivedAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

export function decodeLinePilotCursor(value: string): Cursor {
  const [time, id] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  const receivedAt = new Date(time ?? '');
  if (!id || !UUID.test(id) || Number.isNaN(receivedAt.getTime())) {
    throw new LinePilotInboundCursorError('cursor is unusable');
  }
  return { receivedAt, id };
}

export class LinePilotInboundReader {
  constructor(
    private readonly database: PrismaClient,
    private readonly vault: Pick<EncryptedLineWebhookPayloadVault, 'readPilotView'>,
    private readonly audit: Pick<LineAuditRepository, 'append'>,
    private readonly binding: { tenantId: string; channelAccountId: string },
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(input: {
    actorRef: string;
    limit: number;
    before?: string;
  }): Promise<LinePilotInboundPage> {
    const limit = Math.min(Math.max(Math.trunc(input.limit) || 1, 1), LINE_PILOT_INBOUND_MAX_LIMIT);
    const cursor = input.before ? decodeLinePilotCursor(input.before) : undefined;
    const { tenantId, channelAccountId } = this.binding;
    const [entries, quarantined] = await withTenantDatabaseTransaction(
      this.database,
      tenantId,
      (transaction) =>
        Promise.all([
          transaction.dlLineWebhookInboxEntry.findMany({
            where: {
              tenantId,
              channelAccountId,
              state: { not: 'QUARANTINED' },
              ...(cursor
                ? {
                    OR: [
                      { receivedAt: { lt: cursor.receivedAt } },
                      { receivedAt: cursor.receivedAt, id: { lt: cursor.id } },
                    ],
                  }
                : {}),
            },
            orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
          }),
          transaction.dlLineWebhookInboxEntry.count({
            where: { tenantId, channelAccountId, state: 'QUARANTINED' },
          }),
        ]),
    );
    const page = entries.slice(0, limit);
    const items: LinePilotInboundItem[] = [];
    for (const entry of page) {
      const view = await this.vault.readPilotView(tenantId, entry);
      items.push({
        id: entry.id,
        receivedAt: entry.receivedAt.toISOString(),
        eventType: entry.eventType,
        messageType: view?.messageType ?? null,
        text: view?.text ?? null,
        senderFingerprint: view?.senderFingerprint?.slice(0, FINGERPRINT_LENGTH) ?? null,
        state: entry.state,
      });
    }
    const last = page.at(-1);
    await this.audit.append({
      id: randomUUID(),
      tenantId,
      eventId: `line-inbound-view:${randomUUID()}`,
      category: 'WEBHOOK',
      code: LINE_PILOT_INBOUND_VIEWED,
      actorKind: 'TENANT_ADMIN',
      actorRef: input.actorRef,
      evidenceDigest: createHash('sha256')
        .update(items.map((item) => item.id).join(','))
        .digest('hex'),
      occurredAt: this.now(),
    });
    return {
      items,
      quarantined,
      nextCursor:
        entries.length > limit && last
          ? encodeLinePilotCursor({ receivedAt: last.receivedAt, id: last.id })
          : null,
    };
  }
}

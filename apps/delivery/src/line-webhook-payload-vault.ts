/**
 * Owner: Delivery/Channels — read the operational payload that ingress encrypted (S2.5 #369, #359 §C/§D)
 *
 * the worker and manual replay use this route only: decrypt in memory then extract only the fields used to decide
 * (provider message ID, quoted message ID, one-to-one, sender fingerprint) — the userId, body,
 * replyToken and quoteToken never leave this function and are never forwarded to any layer
 *
 * #566: `readPilotView` is the only way message text leaves the vault — for the read-only pilot page
 * that an admin role of the pilot tenant can read and which is audited; the userId/replyToken/quoteToken still do not leave
 */
import { createDecipheriv } from 'node:crypto';
import {
  withTenantDatabaseTransaction,
  type DlLineWebhookInboxEntry,
  type PrismaClient,
} from '@d-contact/db';
import type { LineInboundProjection, LineWebhookPayloadReader } from './line-webhook-worker.js';
import { lineSourceFingerprint } from './line-webhook-worker.js';

export interface LinePayloadKeyring {
  /** return the key by the keyRef ingress recorded — can be rotated without re-reading the old payload */
  key(keyRef: string): Buffer | undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export const LINE_PILOT_TEXT_MAX_LENGTH = 5000;

export interface LinePilotPayloadView {
  messageType: string | null;
  text: string | null;
  senderFingerprint: string | null;
}

export class EncryptedLineWebhookPayloadVault implements LineWebhookPayloadReader {
  constructor(
    private readonly database: PrismaClient,
    private readonly keyring: LinePayloadKeyring,
  ) {}

  async read(
    tenantId: string,
    entry: DlLineWebhookInboxEntry,
  ): Promise<LineInboundProjection | null> {
    const event = await this.decrypt(tenantId, entry);
    if (!event) return null;
    const source = asObject(event.source);
    const message = asObject(event.message);
    const postback = asObject(event.postback);
    const userId = typeof source?.userId === 'string' ? source.userId : undefined;
    if (!userId) return null;

    const quoted =
      typeof message?.quotedMessageId === 'string' ? message.quotedMessageId : undefined;
    const providerMessageId = typeof message?.id === 'string' ? message.id : undefined;
    const token = typeof postback?.data === 'string' ? postback.data : undefined;
    return {
      ...(providerMessageId ? { providerMessageId } : {}),
      ...(quoted ? { quotedMessageId: quoted } : {}),
      sourceFingerprint: lineSourceFingerprint(entry.channelAccountId, userId),
      isOneToOne: source?.type === 'user',
      ...(token ? { postbackToken: token } : {}),
    };
  }

  /** #566: the view for the pilot page — text only from `message/text` (cut at 5,000 characters), the sender is a fingerprint */
  async readPilotView(
    tenantId: string,
    entry: DlLineWebhookInboxEntry,
  ): Promise<LinePilotPayloadView | null> {
    const event = await this.decrypt(tenantId, entry);
    if (!event) return null;
    const source = asObject(event.source);
    const message = asObject(event.message);
    const userId = typeof source?.userId === 'string' ? source.userId : undefined;
    const messageType = typeof message?.type === 'string' ? message.type : null;
    const text =
      messageType === 'text' && typeof message?.text === 'string'
        ? message.text.slice(0, LINE_PILOT_TEXT_MAX_LENGTH)
        : null;
    return {
      messageType,
      text,
      senderFingerprint: userId ? lineSourceFingerprint(entry.channelAccountId, userId) : null,
    };
  }

  /**
   * S2.6b (#403): the only way a sender's userId leaves the vault — used to record the pilot recipient into the
   * Keychain only. The value may live only in the callback and only for a one-to-one event
   */
  async withOneToOneSourceUserId<T>(
    tenantId: string,
    entry: DlLineWebhookInboxEntry,
    work: (userId: string) => Promise<T>,
  ): Promise<T | null> {
    const event = await this.decrypt(tenantId, entry);
    const source = asObject(event?.source);
    if (source?.type !== 'user' || typeof source.userId !== 'string') return null;
    return work(source.userId);
  }

  private async decrypt(
    tenantId: string,
    entry: DlLineWebhookInboxEntry,
  ): Promise<Record<string, unknown> | undefined> {
    const row = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlLineWebhookPayload.findFirst({
        where: { tenantId, protectedPayloadRef: entry.protectedPayloadRef },
      }),
    );
    if (!row) return undefined;
    const key = this.keyring.key(row.keyRef);
    if (!key) return undefined;

    let plaintext: string;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, row.iv);
      decipher.setAuthTag(row.authTag);
      plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString(
        'utf8',
      );
    } catch {
      // an auth tag that fails = the ciphertext was edited, must not guess the content
      return undefined;
    }
    return asObject(JSON.parse(plaintext) as unknown);
  }
}

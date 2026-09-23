/**
 * Owner: Delivery/Channels — อ่าน operational payload ที่ ingress เข้ารหัสไว้ (S2.5 #369, #359 §C/§D)
 *
 * worker และ manual replay ใช้ทางนี้ทางเดียว: decrypt ใน memory แล้วสกัดเฉพาะ field ที่ใช้ตัดสิน
 * (provider message ID, quoted message ID, one-to-one, fingerprint ของผู้ส่ง) — userId, body,
 * replyToken และ quoteToken ไม่ออกจากฟังก์ชันนี้ และไม่ถูกส่งต่อให้ layer ใด
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
  /** คืน key ตาม keyRef ที่ ingress บันทึกไว้ — rotate ได้โดยไม่ต้องอ่าน payload เดิมใหม่ */
  key(keyRef: string): Buffer | undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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

  /**
   * S2.6b (#403): ทางเดียวที่ userId ของผู้ส่งออกจาก vault — ใช้บันทึก recipient ของ pilot ลง
   * Keychain เท่านั้น ค่าอยู่ได้แค่ใน callback และเฉพาะ event แบบ one-to-one
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
      // auth tag ไม่ผ่าน = ciphertext ถูกแก้ ห้ามเดาเนื้อหา
      return undefined;
    }
    return asObject(JSON.parse(plaintext) as unknown);
  }
}

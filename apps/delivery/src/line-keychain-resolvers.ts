/**
 * Owner: Delivery/Channels — resolver ของ recipient/token สำหรับ LINE pilot บน macOS Keychain
 * (S2.6b #403; decision บน #368 2026-09-23: recipient อยู่ Keychain อ้างด้วย opaque ref)
 *
 * - recipient: Keychain service `d-contact.line.<channel>` account `recipient.<ref>`; ค่าที่อ่านได้
 *   ต้องเป็น LINE user ID และ fingerprint ต้องตรง allowlist ของ ref นั้น ไม่ตรง = `null` ก่อน barrier
 *   (กันการส่งผิดคนเมื่อ Keychain item ถูกเปลี่ยน)
 * - token: metadata จาก `dl_line_credential_refs` → `LineCredentialBoundary` (status/expiry/version/
 *   fingerprint) → ค่าในหน่วยความจำเท่านั้น
 * - capture: บันทึกผู้ส่ง signed message webhook เป็น recipient ของ pilot โดยค่าไม่ออกนอก callback
 */
import { randomUUID } from 'node:crypto';
import {
  withTenantDatabaseTransaction,
  type DlLineWebhookInboxEntry,
  type PrismaClient,
} from '@d-contact/db';
import {
  LineCredentialBoundary,
  type LineKeychainReference,
  type LineSecretSource,
} from './line-credential-boundary.js';
import {
  lineKeychainServiceName,
  type KeychainLineSecretWriter,
} from './line-keychain-secret-source.js';
import type { LineAccessTokenResolver, LineRecipientResolver } from './line-outbound-adapter.js';
import type { EncryptedLineWebhookPayloadVault } from './line-webhook-payload-vault.js';
import { lineSourceFingerprint } from './line-webhook-worker.js';

const RECIPIENT_REF = /^kc-recipient-[0-9a-f-]{36}$/;
const LINE_USER_ID = /^U[0-9a-f]{32}$/;

export function lineRecipientKeychainReference(
  channelAccountId: string,
  recipientProtectedRef: string,
): LineKeychainReference {
  if (!RECIPIENT_REF.test(recipientProtectedRef)) {
    throw new TypeError('recipientProtectedRef ไม่ใช่ Keychain ref ของ pilot');
  }
  return {
    keychainService: lineKeychainServiceName(channelAccountId),
    keychainAccount: `recipient.${recipientProtectedRef}`,
  };
}

export class KeychainLineRecipientResolver implements LineRecipientResolver {
  constructor(
    private readonly database: PrismaClient,
    private readonly source: LineSecretSource,
  ) {}

  async resolve(input: {
    tenantId: string;
    recipientProtectedRef: string;
  }): Promise<{ userId: string } | null> {
    if (!RECIPIENT_REF.test(input.recipientProtectedRef)) return null;
    const entry = await withTenantDatabaseTransaction(
      this.database,
      input.tenantId,
      (transaction) =>
        transaction.dlLineAllowlistEntry.findFirst({
          where: {
            tenantId: input.tenantId,
            recipientProtectedRef: input.recipientProtectedRef,
            revokedAt: null,
          },
          select: { channelAccountId: true, recipientFingerprint: true },
        }),
    );
    if (!entry) return null;
    let userId: string;
    try {
      userId = await this.source.read(
        lineRecipientKeychainReference(entry.channelAccountId, input.recipientProtectedRef),
      );
    } catch {
      return null;
    }
    if (!LINE_USER_ID.test(userId)) return null;
    if (lineSourceFingerprint(entry.channelAccountId, userId) !== entry.recipientFingerprint) {
      return null;
    }
    return { userId };
  }
}

export class KeychainLineAccessTokenResolver implements LineAccessTokenResolver {
  private readonly boundary: LineCredentialBoundary;

  constructor(
    private readonly database: PrismaClient,
    source: LineSecretSource,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.boundary = new LineCredentialBoundary(source);
  }

  async resolve(input: {
    tenantId: string;
    credentialRefId: string;
    version: number;
  }): Promise<{ accessToken: string } | null> {
    const metadata = await withTenantDatabaseTransaction(
      this.database,
      input.tenantId,
      (transaction) =>
        transaction.dlLineCredentialRef.findFirst({
          where: { tenantId: input.tenantId, id: input.credentialRefId },
        }),
    );
    if (!metadata) return null;
    try {
      const handle = await this.boundary.resolve(metadata, input.version, this.now());
      return await handle.use(async (accessToken) => ({ accessToken }));
    } catch {
      return null;
    }
  }
}

export interface CapturedLineRecipient {
  recipientProtectedRef: string;
  recipientFingerprint: string;
}

/**
 * ใช้ signed message webhook ล่าสุดของ one-to-one chat (เช่นที่ส่งมาตอน PR01) เป็น recipient:
 * ผู้ใช้ไม่ต้องพิมพ์หรือเห็น user ID และค่าเขียนลง Keychain ได้ทางเดียว คืนแค่ ref + fingerprint
 */
export async function captureLineRecipientFromWebhook(input: {
  database: PrismaClient;
  vault: EncryptedLineWebhookPayloadVault;
  writer: KeychainLineSecretWriter;
  tenantId: string;
  channelAccountId: string;
  since: Date;
  newRef?: () => string;
}): Promise<CapturedLineRecipient | null> {
  const entries: DlLineWebhookInboxEntry[] = await withTenantDatabaseTransaction(
    input.database,
    input.tenantId,
    (transaction) =>
      transaction.dlLineWebhookInboxEntry.findMany({
        where: {
          tenantId: input.tenantId,
          channelAccountId: input.channelAccountId,
          eventType: 'message',
          receivedAt: { gte: input.since },
          state: { not: 'QUARANTINED' },
        },
        orderBy: { receivedAt: 'desc' },
        take: 1,
      }),
  );
  const entry = entries[0];
  if (!entry) return null;
  const recipientProtectedRef = `kc-recipient-${(input.newRef ?? randomUUID)()}`;
  return input.vault.withOneToOneSourceUserId(input.tenantId, entry, async (userId) => {
    if (!LINE_USER_ID.test(userId)) return null;
    await input.writer.write(
      lineRecipientKeychainReference(input.channelAccountId, recipientProtectedRef),
      userId,
    );
    return {
      recipientProtectedRef,
      recipientFingerprint: lineSourceFingerprint(input.channelAccountId, userId),
    };
  });
}

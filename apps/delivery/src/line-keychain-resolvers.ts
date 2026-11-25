/**
 * Owner: Delivery/Channels — resolver of recipient/token for the LINE pilot on the macOS Keychain
 * (S2.6b #403; decision on #368 2026-09-23: the recipient lives in the Keychain, referenced by an opaque ref)
 *
 * - recipient: Keychain service `d-contact.line.<channel>` account `recipient.<ref>`; the value read
 *   must be a LINE user ID and the fingerprint must match the allowlist of that ref, otherwise `null` before the barrier
 *   (prevents sending to the wrong person if the Keychain item is replaced)
 * - token: metadata from `dl_line_credential_refs` → `LineCredentialBoundary` (status/expiry/version/
 *   fingerprint) → value in memory only
 * - capture: records the sender of a signed message webhook as the pilot recipient, with the value never leaving the callback
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
import type { LineSecretWriter } from './line-file-secret-source.js';
import { lineKeychainServiceName } from './line-keychain-secret-source.js';
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
    throw new TypeError('recipientProtectedRef is not a Keychain ref of the pilot');
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
 * Uses the latest signed message webhook of a one-to-one chat (e.g. the one sent at PR01) as the recipient:
 * the user need not type or see the user ID, and the value can be written to the Keychain only one way, returning just ref + fingerprint
 */
export async function captureLineRecipientFromWebhook(input: {
  database: PrismaClient;
  vault: EncryptedLineWebhookPayloadVault;
  writer: LineSecretWriter;
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

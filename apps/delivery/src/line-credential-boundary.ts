/**
 * Owner: Delivery/Channels — credential boundary of the LINE control plane (S2.3 #367)
 *
 * Authority: #358 §G and account authority #356 §2
 *
 * The single rule of this file: **a secret value may live only in the memory of the provider boundary**
 * - no reading of environment variables, no CLI argument, no writing to database/log/evidence
 * - only metadata (ref/version/fingerprint/expiry) may leave here
 * - `LineSecretHandle` can be used once and then erases its own value, and serializes as `[REDACTED]`
 *   by every route (`toString`/`toJSON`/`util.inspect`) so that accidentally logging the whole object still does not leak
 *
 * Reading the real secret from the macOS Keychain is the job of `LineSecretSource`, which the owner of the
 * provider transport injects (S2.4) — S2.3 has no I/O at all, neither to the Keychain nor to LINE
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';
import {
  LINE_FORBIDDEN_EVIDENCE_FIELDS,
  type LineCredentialKind,
  type LineCredentialStatus,
  type LineGateErrorCode,
} from '@d-contact/cxa-contracts';

/** The name of the secret in the Keychain, not the secret itself — this value may be stored in the database */
export interface LineKeychainReference {
  keychainService: string;
  keychainAccount: string;
}

/** The only party that "sees" the real value; the implementation lives on the provider boundary side only */
export interface LineSecretSource {
  read(reference: LineKeychainReference): Promise<string>;
}

/** Durable metadata — its shape matches the `dl_line_credential_refs` row without being bound to Prisma */
export interface LineCredentialMetadata {
  id: string;
  version: number;
  credentialKind: LineCredentialKind;
  status: LineCredentialStatus;
  keychainService: string;
  keychainAccount: string;
  fingerprint: string;
  expiresAt: Date | null;
  revokedAt?: Date | null;
}

export type LineCredentialErrorCode = Extract<
  LineGateErrorCode,
  'CREDENTIAL_UNAVAILABLE' | 'CREDENTIAL_VERSION_MISMATCH'
>;

/**
 * The message of this error must not contain the secret value, Keychain detail reasons, or the ID of
 * another tenant — the caller gets only a machine code, enough to fail closed correctly
 */
export class LineCredentialBoundaryError extends Error {
  constructor(readonly code: LineCredentialErrorCode) {
    super(`LINE credential unusable: ${code}`);
    this.name = 'LineCredentialBoundaryError';
  }
}

/** The fingerprint stored in the database is the sha256 of the value, not the value itself, so it cannot be reversed */
export function lineSecretFingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function fingerprintMatches(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

const REDACTED = '[REDACTED]';

/**
 * A handle that holds the secret value temporarily: `use()` works once, after which the value in the handle is erased.
 * The value is never returned directly — the caller receives it only inside a callback they write themselves
 */
export class LineSecretHandle {
  #secret: string | undefined;
  #used = false;

  constructor(
    secret: string,
    readonly credentialRefId: string,
    readonly version: number,
    readonly fingerprint: string,
  ) {
    this.#secret = secret;
  }

  get consumed(): boolean {
    return this.#used;
  }

  /** Use the value exactly once and only within the callback scope; the value is always discarded even if the callback throws */
  async use<T>(work: (secret: string) => Promise<T> | T): Promise<T> {
    if (this.#used || this.#secret === undefined) {
      throw new LineCredentialBoundaryError('CREDENTIAL_UNAVAILABLE');
    }
    const secret = this.#secret;
    this.#used = true;
    this.#secret = undefined;
    return await work(secret);
  }

  /** Discard the value without using it — used on fail closed after resolve but before crossing the barrier */
  dispose(): void {
    this.#used = true;
    this.#secret = undefined;
  }

  toJSON(): Record<string, string | number | boolean> {
    return {
      credentialRefId: this.credentialRefId,
      version: this.version,
      fingerprint: this.fingerprint,
      secret: REDACTED,
      consumed: this.#used,
    };
  }

  toString(): string {
    return `LineSecretHandle(${this.credentialRefId}#${this.version} ${REDACTED})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/**
 * The single gate that turns metadata into a usable value, checking everything before touching the Keychain:
 * status/revoke/expiry/version failing = the value is never read, and a value already read whose fingerprint does not match the
 * approved metadata is discarded immediately without being forwarded (so a rotation stuck halfway fails closed)
 */
export class LineCredentialBoundary {
  constructor(private readonly source: LineSecretSource) {}

  async resolve(
    metadata: LineCredentialMetadata,
    expectedVersion: number,
    at: Date,
  ): Promise<LineSecretHandle> {
    if (metadata.version !== expectedVersion) {
      throw new LineCredentialBoundaryError('CREDENTIAL_VERSION_MISMATCH');
    }
    if (metadata.status !== 'ACTIVE' || metadata.revokedAt) {
      throw new LineCredentialBoundaryError('CREDENTIAL_UNAVAILABLE');
    }
    if (metadata.expiresAt !== null && metadata.expiresAt.getTime() <= at.getTime()) {
      throw new LineCredentialBoundaryError('CREDENTIAL_UNAVAILABLE');
    }

    let secret: string;
    try {
      secret = await this.source.read({
        keychainService: metadata.keychainService,
        keychainAccount: metadata.keychainAccount,
      });
    } catch {
      // The real Keychain message may contain the item name or value — forward neither the message nor the cause
      throw new LineCredentialBoundaryError('CREDENTIAL_UNAVAILABLE');
    }
    if (!secret) throw new LineCredentialBoundaryError('CREDENTIAL_UNAVAILABLE');
    if (!fingerprintMatches(lineSecretFingerprint(secret), metadata.fingerprint)) {
      throw new LineCredentialBoundaryError('CREDENTIAL_UNAVAILABLE');
    }
    return new LineSecretHandle(secret, metadata.id, metadata.version, metadata.fingerprint);
  }
}

export class LineForbiddenFieldError extends Error {
  readonly code = 'PII_OR_CREDENTIAL_LEAK';

  constructor(readonly field: string) {
    super(`payload has a field that must not leave the provider boundary: ${field}`);
    this.name = 'LineForbiddenFieldError';
  }
}

const FORBIDDEN_FIELDS = new Set(
  LINE_FORBIDDEN_EVIDENCE_FIELDS.map((field) => field.toLowerCase()),
);

/**
 * The last gate before writing audit/evidence: reject a payload that has a forbidden field name per #362 §5
 * no matter how deeply nested — checks the field name, not the content, because redacted content can still pass
 */
export function assertRedactedPayload(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertRedactedPayload(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (value instanceof Date) return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(key.toLowerCase()))
      throw new LineForbiddenFieldError(`${path}.${key}`);
    assertRedactedPayload(nested, `${path}.${key}`);
  }
}

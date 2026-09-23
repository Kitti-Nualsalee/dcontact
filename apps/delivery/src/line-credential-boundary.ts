/**
 * Owner: Delivery/Channels — credential boundary ของ LINE control plane (S2.3 #367)
 *
 * Authority: #358 §G และ account authority #356 §2
 *
 * กติกาเดียวของไฟล์นี้: **secret value มีชีวิตได้เฉพาะใน memory ของ provider boundary**
 * - ไม่มีการอ่าน environment variable, ไม่มี argument ของ CLI, ไม่เขียนลง database/log/evidence
 * - ค่าที่ออกจากที่นี่ได้คือ metadata (ref/version/fingerprint/expiry) เท่านั้น
 * - `LineSecretHandle` ใช้ได้ครั้งเดียวแล้วลบค่าในตัวเองทิ้ง และ serialize ออกมาเป็น `[REDACTED]`
 *   ทุกทาง (`toString`/`toJSON`/`util.inspect`) เพื่อให้เผลอ log ทั้ง object แล้วก็ยังไม่รั่ว
 *
 * การอ่าน secret จริงจาก macOS Keychain เป็นหน้าที่ของ `LineSecretSource` ที่ owner ของ
 * provider transport ฉีดเข้ามา (S2.4) — S2.3 ไม่มี I/O ใด ๆ ทั้งกับ Keychain และกับ LINE
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';
import {
  LINE_FORBIDDEN_EVIDENCE_FIELDS,
  type LineCredentialKind,
  type LineCredentialStatus,
  type LineGateErrorCode,
} from '@d-contact/cxa-contracts';

/** ชื่อของ secret ใน Keychain ไม่ใช่ตัว secret — ค่านี้เก็บใน database ได้ */
export interface LineKeychainReference {
  keychainService: string;
  keychainAccount: string;
}

/** ผู้เดียวที่ "เห็น" ค่าจริง; implementation อยู่ฝั่ง provider boundary เท่านั้น */
export interface LineSecretSource {
  read(reference: LineKeychainReference): Promise<string>;
}

/** metadata ที่ durable — รูปร่างตรงกับแถว `dl_line_credential_refs` โดยไม่ผูกกับ Prisma */
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
 * ข้อความของ error ตัวนี้ต้องไม่มีค่า secret, ไม่มีเหตุผลละเอียดของ Keychain และไม่มี ID ของ
 * tenant อื่น — ผู้เรียกได้แค่ machine code พอให้ fail closed ถูกทาง
 */
export class LineCredentialBoundaryError extends Error {
  constructor(readonly code: LineCredentialErrorCode) {
    super(`credential ของ LINE ใช้ไม่ได้: ${code}`);
    this.name = 'LineCredentialBoundaryError';
  }
}

/** fingerprint ที่เก็บใน database คือ sha256 ของค่า ไม่ใช่ค่าเอง จึงย้อนกลับไม่ได้ */
export function lineSecretFingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function fingerprintMatches(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

const REDACTED = '[REDACTED]';

/**
 * handle ที่ถือค่า secret ไว้ชั่วคราว: `use()` ได้ครั้งเดียว หลังจากนั้นค่าใน handle ถูกลบ
 * ค่าไม่เคยถูก return ออกไปตรง ๆ — ผู้เรียกได้รับค่าเฉพาะใน callback ที่ตัวเองเขียน
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

  /** ใช้ค่าได้ครั้งเดียวและเฉพาะในขอบเขตของ callback; ค่าถูกทิ้งเสมอแม้ callback จะ throw */
  async use<T>(work: (secret: string) => Promise<T> | T): Promise<T> {
    if (this.#used || this.#secret === undefined) {
      throw new LineCredentialBoundaryError('CREDENTIAL_UNAVAILABLE');
    }
    const secret = this.#secret;
    this.#used = true;
    this.#secret = undefined;
    return await work(secret);
  }

  /** ทิ้งค่าทิ้งโดยไม่ใช้ — ใช้ตอน fail closed หลัง resolve แล้วแต่ยังไม่ข้าม barrier */
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
 * ด่านเดียวที่แปลง metadata เป็นค่าใช้งานได้ ตรวจครบก่อนแตะ Keychain:
 * status/revoke/expiry/version ไม่ผ่าน = ไม่อ่านค่าเลย และค่าที่อ่านมาแล้ว fingerprint ไม่ตรง
 * metadata ที่อนุมัติไว้ ก็ถูกทิ้งทันทีโดยไม่ส่งต่อ (rotation ค้างครึ่งทางจึง fail closed)
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
      // ข้อความจริงของ Keychain อาจมีชื่อ item หรือค่า — ไม่ส่งต่อทั้งข้อความและ cause
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
    super(`payload มี field ที่ห้ามออกนอก provider boundary: ${field}`);
    this.name = 'LineForbiddenFieldError';
  }
}

const FORBIDDEN_FIELDS = new Set(
  LINE_FORBIDDEN_EVIDENCE_FIELDS.map((field) => field.toLowerCase()),
);

/**
 * ด่านสุดท้ายก่อนเขียน audit/evidence: ปฏิเสธ payload ที่มีชื่อ field ต้องห้ามตาม #362 §5
 * ไม่ว่าจะซ้อนลึกแค่ไหน — ตรวจชื่อ field ไม่ใช่เนื้อหา เพราะเนื้อหาที่ redact แล้วยังผ่านได้
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

/**
 * Owner: Delivery/Channels — ตัวอ่าน secret ของ LINE จากไฟล์บน Linux (#565 S4, ADR-031)
 *
 * ใช้แทน macOS Keychain บน UAT VM2: Compose `secrets` mount ไฟล์ read-only ไว้ที่ directory เดียว
 * (ค่าเริ่ม `/run/secrets`) และ recipient ที่ runner บันทึกเองอยู่ใน state directory ที่เขียนได้
 *
 * - reference ยังเป็น `LineKeychainReference` เดิม (เก็บใน database ได้) — map เป็นชื่อไฟล์คงที่
 *   และรับเฉพาะ service ของ channel ที่ผูกไว้ตอนสร้าง
 * - ไฟล์ที่ group/other อ่านหรือเขียนได้ = ใช้ไม่ได้ (fail closed) เพราะแปลว่าสิทธิ์ถูกตั้งผิด
 * - error ไม่มี path, ชื่อไฟล์หรือค่า — ผู้เรียกได้แค่ `CREDENTIAL_UNAVAILABLE`
 */
import { constants } from 'node:fs';
import { chmod, mkdir, open, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LineKeychainReference, LineSecretSource } from './line-credential-boundary.js';
import { LineKeychainReadError, lineKeychainServiceName } from './line-keychain-secret-source.js';

export const LINE_SECRET_SOURCES = ['keychain', 'file'] as const;
export type LineSecretSourceKind = (typeof LINE_SECRET_SOURCES)[number];

export const DEFAULT_LINE_CREDENTIAL_DIR = '/run/secrets';

/** account ของ secret ที่ operator ใส่ (read-only) → ชื่อไฟล์ใน secret directory */
export const LINE_SECRET_FILES: Readonly<Record<string, string>> = Object.freeze({
  'channel-access-token': 'line-channel-access-token',
  'channel-secret': 'line-channel-secret',
  'webhook-payload-key': 'line-webhook-payload-key',
});

const RECIPIENT_ACCOUNT = /^recipient\.(kc-recipient-[0-9a-f-]{36})$/;
const WRITABLE_VALUE = /^[A-Za-z0-9._~+/=-]{1,4096}$/;
const MAX_SECRET_BYTES = 8192;

export interface LineSecretWriter {
  write(reference: LineKeychainReference, value: string): Promise<void>;
}

export interface FileLineSecretOptions {
  channelAccountId: string;
  /** directory ของไฟล์จาก Compose `secrets` */
  secretDir?: string;
  /** state directory ของ runner — recipient อยู่ใต้ `recipients/`; ไม่มี = อ่าน/เขียน recipient ไม่ได้ */
  stateDir?: string;
}

function recipientPath(stateDir: string | undefined, account: string): string | null {
  const match = RECIPIENT_ACCOUNT.exec(account);
  if (!match || !stateDir) return null;
  return join(stateDir, 'recipients', match[1]!);
}

export class FileLineSecretSource implements LineSecretSource {
  private readonly service: string;
  private readonly secretDir: string;

  constructor(private readonly options: FileLineSecretOptions) {
    this.service = lineKeychainServiceName(options.channelAccountId);
    this.secretDir = options.secretDir ?? DEFAULT_LINE_CREDENTIAL_DIR;
  }

  private pathOf(reference: LineKeychainReference): string | null {
    if (reference.keychainService !== this.service) return null;
    const file = LINE_SECRET_FILES[reference.keychainAccount];
    if (file) return join(this.secretDir, file);
    return recipientPath(this.options.stateDir, reference.keychainAccount);
  }

  async read(reference: LineKeychainReference): Promise<string> {
    const path = this.pathOf(reference);
    if (!path) throw new LineKeychainReadError();
    let raw: Buffer;
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > MAX_SECRET_BYTES) {
          throw new LineKeychainReadError();
        }
        raw = await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch {
      throw new LineKeychainReadError();
    }
    // operator อาจใส่ newline ท้ายไฟล์ — ตัดเฉพาะตัวนั้น ค่า secret จริงไม่มี whitespace ปลาย
    const secret = raw.toString('utf8').replace(/\r?\n$/, '');
    raw.fill(0);
    if (!secret || /\s/.test(secret)) throw new LineKeychainReadError();
    return secret;
  }
}

/**
 * เขียนได้เฉพาะ recipient ลง state directory (`0600`) — secret ของ operator อยู่บน mount read-only
 * และเปลี่ยนได้ทาง `vm2-line-secrets.sh` เท่านั้น
 */
export class FileLineSecretWriter implements LineSecretWriter {
  private readonly service: string;

  constructor(private readonly options: FileLineSecretOptions) {
    this.service = lineKeychainServiceName(options.channelAccountId);
  }

  async write(reference: LineKeychainReference, value: string): Promise<void> {
    const path =
      reference.keychainService === this.service
        ? recipientPath(this.options.stateDir, reference.keychainAccount)
        : null;
    if (!path || !WRITABLE_VALUE.test(value)) throw new LineKeychainReadError();
    const directory = join(this.options.stateDir!, 'recipients');
    const temporary = `${path}.tmp`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await stat(directory);
      if ((info.mode & 0o077) !== 0) await chmod(directory, 0o700);
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(value, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } catch {
      throw new LineKeychainReadError();
    }
  }
}

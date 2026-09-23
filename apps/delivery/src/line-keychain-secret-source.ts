/**
 * Owner: Delivery/Channels — ตัวอ่าน secret จาก macOS Keychain ของ protected runner (S2.6 #366)
 *
 * Authority: #358 §G, #360 §C
 *
 * ใช้ได้เฉพาะบนเครื่องของ protected runner เท่านั้น: CI ทั่วไปไม่มี Keychain และห้ามมี secret ใน
 * env/argument/log/artifact ค่าที่อ่านได้ส่งต่อให้ `LineCredentialBoundary` ทันที ซึ่งตรวจ fingerprint
 * แล้วห่อเป็น `LineSecretHandle` แบบใช้ครั้งเดียว
 *
 * `security` ส่งค่าออกทาง stdout ของ child process เท่านั้น — ไม่ใช้ shell และไม่ส่ง stdout/stderr
 * ต่อไปใน error เพราะข้อความของ Keychain อาจมีชื่อ item หรือค่าบางส่วน
 */
import { execFile } from 'node:child_process';
import type { LineKeychainReference, LineSecretSource } from './line-credential-boundary.js';

export const MACOS_SECURITY_BINARY = '/usr/bin/security';

/** service เดียวของทุก item ของ channel หนึ่ง (token/secret/payload key/recipient) */
export function lineKeychainServiceName(channelAccountId: string): string {
  return `d-contact.line.${channelAccountId}`;
}

export type LineKeychainExec = (
  file: string,
  arguments_: readonly string[],
) => Promise<{ stdout: string }>;

const defaultExec: LineKeychainExec = (file, arguments_) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...arguments_],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, stdout) => (error ? reject(new Error('keychain read failed')) : resolve({ stdout })),
    );
  });

/** ชื่อ service/account เป็น reference ไม่ใช่ secret แต่ก็จำกัดรูปแบบไว้กัน argument injection */
const REFERENCE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class LineKeychainReadError extends Error {
  readonly code = 'CREDENTIAL_UNAVAILABLE';

  constructor() {
    super('อ่าน credential จาก Keychain ไม่ได้');
    this.name = 'LineKeychainReadError';
  }
}

export class KeychainLineSecretSource implements LineSecretSource {
  constructor(
    private readonly exec: LineKeychainExec = defaultExec,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async read(reference: LineKeychainReference): Promise<string> {
    if (this.platform !== 'darwin') throw new LineKeychainReadError();
    if (
      !REFERENCE_PART.test(reference.keychainService) ||
      !REFERENCE_PART.test(reference.keychainAccount)
    ) {
      throw new LineKeychainReadError();
    }
    let stdout: string;
    try {
      ({ stdout } = await this.exec(MACOS_SECURITY_BINARY, [
        'find-generic-password',
        '-s',
        reference.keychainService,
        '-a',
        reference.keychainAccount,
        '-w',
      ]));
    } catch {
      throw new LineKeychainReadError();
    }
    // `-w` พิมพ์ค่าตามด้วย newline หนึ่งตัว — ตัดเฉพาะตัวนั้น ค่า secret จริงไม่มี whitespace ปลาย
    const secret = stdout.replace(/\r?\n$/, '');
    if (!secret) throw new LineKeychainReadError();
    return secret;
  }
}

export type LineKeychainStdinExec = (
  file: string,
  arguments_: readonly string[],
  stdin: string,
) => Promise<void>;

const defaultStdinExec: LineKeychainStdinExec = (file, arguments_, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, [...arguments_], { timeout: 10_000 }, (error) =>
      error ? reject(new Error('keychain write failed')) : resolve(),
    );
    child.stdin?.end(stdin);
  });

/** ค่า Keychain ห้ามมี quote/backslash/newline เพราะ `security -i` แยกคำสั่งตามบรรทัด */
const WRITABLE_VALUE = /^[A-Za-z0-9._~+/=-]{1,4096}$/;

/**
 * S2.6b (#403): เขียน item ลง Keychain โดยส่งคำสั่งผ่าน stdin ของ `security -i` — ค่าไม่ปรากฏใน
 * argv ของ process จึงไม่เห็นผ่าน `ps` และ error ไม่พาค่าออกมา (`-U` = update ถ้ามีอยู่แล้ว)
 */
export class KeychainLineSecretWriter {
  constructor(
    private readonly exec: LineKeychainStdinExec = defaultStdinExec,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async write(reference: LineKeychainReference, value: string): Promise<void> {
    if (
      this.platform !== 'darwin' ||
      !REFERENCE_PART.test(reference.keychainService) ||
      !REFERENCE_PART.test(reference.keychainAccount) ||
      !WRITABLE_VALUE.test(value)
    ) {
      throw new LineKeychainReadError();
    }
    try {
      await this.exec(
        MACOS_SECURITY_BINARY,
        ['-i'],
        `add-generic-password -U -s ${reference.keychainService} -a ${reference.keychainAccount} -w ${value}\n`,
      );
    } catch {
      throw new LineKeychainReadError();
    }
  }
}

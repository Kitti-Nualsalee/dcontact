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

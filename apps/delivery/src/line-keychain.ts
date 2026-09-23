/**
 * Owner: Delivery/Channels — อ่าน secret ของ LINE จาก macOS Keychain (S2.5 #369)
 *
 * Authority: #356 §2, #358 §G และ #362 §9 — secret อยู่ Keychain เท่านั้น ไม่ผ่าน env/argv/log
 *
 * ใช้ `security find-generic-password -w` แบบ execFile (ไม่ผ่าน shell) ค่าที่อ่านได้อยู่ใน memory
 * ของ process นี้เท่านั้น error ที่โยนออกไปไม่มีชื่อ service/account หรือ stderr ของ `security`
 * implement `LineSecretSource` ของ S2.3 จึงให้ S2.4 ใช้อ่าน access token ด้วยตัวเดียวกันได้
 */
import { execFile } from 'node:child_process';
import type { LineKeychainReference, LineSecretSource } from './line-credential-boundary.js';

export class LineKeychainUnavailableError extends Error {
  readonly code = 'CREDENTIAL_UNAVAILABLE';

  constructor() {
    super('อ่าน secret ของ LINE จาก Keychain ไม่ได้');
    this.name = 'LineKeychainUnavailableError';
  }
}

export class MacosKeychainSecretSource implements LineSecretSource {
  read(reference: LineKeychainReference): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        '/usr/bin/security',
        [
          'find-generic-password',
          '-s',
          reference.keychainService,
          // account ว่าง = item ที่ผูกแค่ service (แบบที่ตั้งไว้ตอนทำ #356)
          ...(reference.keychainAccount ? ['-a', reference.keychainAccount] : []),
          '-w',
        ],
        { encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 },
        (error, stdout) => {
          const value = stdout?.replace(/\n$/, '') ?? '';
          if (error || value.length === 0) {
            reject(new LineKeychainUnavailableError());
            return;
          }
          resolve(value);
        },
      );
    });
  }
}

/**
 * Owner: Delivery/Channels — secret reader from the macOS Keychain of the protected runner (S2.6 #366)
 *
 * Authority: #358 §G, #360 §C
 *
 * Usable only on the protected runner machine: general CI has no Keychain and must have no secret in
 * env/argument/log/artifact. The value read is forwarded immediately to `LineCredentialBoundary`, which checks the fingerprint
 * then wraps it in a single-use `LineSecretHandle`
 *
 * `security` outputs the value only on the child process's stdout — no shell is used and stdout/stderr are not passed
 * on in errors because a Keychain message may contain the item name or part of the value
 */
import { execFile } from 'node:child_process';
import type { LineKeychainReference, LineSecretSource } from './line-credential-boundary.js';

export const MACOS_SECURITY_BINARY = '/usr/bin/security';

/** The single service of every item of a channel (token/secret/payload key/recipient) */
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

/** Service/account names are references, not secrets, but their format is restricted to prevent argument injection */
const REFERENCE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class LineKeychainReadError extends Error {
  readonly code = 'CREDENTIAL_UNAVAILABLE';

  constructor() {
    super('cannot read the credential from the Keychain');
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
    // `-w` prints the value followed by one newline — trim only that; a real secret value has no trailing whitespace
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

/** A Keychain value must not contain quote/backslash/newline because `security -i` splits commands by line */
const WRITABLE_VALUE = /^[A-Za-z0-9._~+/=-]{1,4096}$/;

/**
 * S2.6b (#403): write an item into the Keychain by sending the command through the stdin of `security -i` — the value does not appear in
 * the process argv so it is invisible through `ps` and the error does not carry the value (`-U` = update if it already exists)
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

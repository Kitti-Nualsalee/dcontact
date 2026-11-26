/**
 * Owner: Delivery/Channels — reader of LINE secrets from files on Linux (#565 S4, ADR-031)
 *
 * Replaces the macOS Keychain on UAT VM2: Compose `secrets` mounts files read-only in a single directory
 * (default `/run/secrets`) and the recipient the runner records itself lives in a writable state directory
 *
 * - the reference remains the existing `LineKeychainReference` (storable in the database) — mapped to a fixed file name
 *   and accepts only the service of the channel bound at construction
 * - a file readable or writable by group/other = unusable (fail closed) because it means permissions were set wrongly
 * - the error has no path, file name or value — the caller gets only `CREDENTIAL_UNAVAILABLE`
 */
import { constants } from 'node:fs';
import { chmod, mkdir, open, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LineKeychainReference, LineSecretSource } from './line-credential-boundary.js';
import { lineKeychainServiceName } from './line-keychain-secret-source.js';

export const LINE_SECRET_SOURCES = ['keychain', 'file'] as const;
export type LineSecretSourceKind = (typeof LINE_SECRET_SOURCES)[number];

export const DEFAULT_LINE_CREDENTIAL_DIR = '/run/secrets';

/** account of a secret the operator supplies (read-only) → file name in the secret directory */
export const LINE_SECRET_FILES: Readonly<Record<string, string>> = Object.freeze({
  'channel-access-token': 'line-channel-access-token',
  'channel-secret': 'line-channel-secret',
  'webhook-payload-key': 'line-webhook-payload-key',
});

const RECIPIENT_ACCOUNT = /^recipient\.(kc-recipient-[0-9a-f-]{36})$/;
const WRITABLE_VALUE = /^[A-Za-z0-9._~+/=-]{1,4096}$/;
const MAX_SECRET_BYTES = 8192;

export class LineFileSecretReadError extends Error {
  readonly code = 'CREDENTIAL_UNAVAILABLE';

  constructor() {
    super('cannot read the credential from the file');
    this.name = 'LineFileSecretReadError';
  }
}

export interface LineSecretWriter {
  write(reference: LineKeychainReference, value: string): Promise<void>;
}

export interface FileLineSecretOptions {
  channelAccountId: string;
  /** directory of the files from Compose `secrets` */
  secretDir?: string;
  /** state directory of the runner — the recipient lives under `recipients/`; absent = cannot read/write the recipient */
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
    if (!path) throw new LineFileSecretReadError();
    let raw: Buffer;
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > MAX_SECRET_BYTES) {
          throw new LineFileSecretReadError();
        }
        raw = await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch {
      throw new LineFileSecretReadError();
    }
    // the operator may put a newline at the end of the file — trim only that; a real secret value has no trailing whitespace
    const secret = raw.toString('utf8').replace(/\r?\n$/, '');
    raw.fill(0);
    if (!secret || /\s/.test(secret)) throw new LineFileSecretReadError();
    return secret;
  }
}

/**
 * Can write only the recipient into the state directory (`0600`) — the operator's secret is on a read-only mount
 * and can be changed only through `vm2-line-secrets.sh`
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
    if (!path || !WRITABLE_VALUE.test(value)) throw new LineFileSecretReadError();
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
      throw new LineFileSecretReadError();
    }
  }
}

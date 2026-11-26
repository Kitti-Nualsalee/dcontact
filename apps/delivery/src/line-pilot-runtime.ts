/**
 * Owner: Delivery/Channels — runtime environment of the LINE pilot CLI (#565 S1/S4, ADR-031)
 *
 * All three CLIs (`provider:pr01`, `pilot:setup`, `pilot`) can run in two places:
 *
 * - `keychain` (default): the existing protected runner on macOS — secrets from the Keychain, provenance from a Git checkout
 * - `file`: the `line-pilot` runner on UAT VM2 — secrets from the Compose `secrets` files, recipient/state in a volume
 *   and provenance from the deployed release (`DCONTACT_BUILD_SHA` of the image) because a container has no Git
 *
 * env selects only the mode and paths — no secret in env (#362 §9)
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { LineSecretSource } from './line-credential-boundary.js';
import {
  FileLineSecretSource,
  FileLineSecretWriter,
  LINE_SECRET_SOURCES,
  type LineSecretSourceKind,
  type LineSecretWriter,
} from './line-file-secret-source.js';
import {
  KeychainLineSecretSource,
  KeychainLineSecretWriter,
} from './line-keychain-secret-source.js';
import { LINE_PILOT_CHANNEL_ACCOUNT_ID } from './line-provider-conformance.js';

const SHA = /^[0-9a-f]{40}$/;

export interface LinePilotProvenance {
  /** the commit the evidence is bound to */
  commitSha: string;
  /** confirm that the code running is really that commit — failing = throw */
  assertFinalMain(expected?: string): void;
  migrationsDir: string;
  registryPath: string;
}

export interface LinePilotRuntime {
  kind: LineSecretSourceKind;
  source: LineSecretSource;
  writer: LineSecretWriter;
  stateDir: string;
  bundleDir: string;
  provenance(): LinePilotProvenance;
}

export class LinePilotRuntimeError extends Error {
  constructor(
    readonly code:
      | 'SECRET_SOURCE_UNKNOWN'
      | 'PLATFORM_MISMATCH'
      | 'RELEASE_SHA_INVALID'
      | 'PATH_REQUIRED'
      | 'NOT_FINAL_MAIN',
  ) {
    super(`line pilot runtime: ${code}`);
    this.name = 'LinePilotRuntimeError';
  }
}

export function linePilotSecretSourceKind(
  environment: NodeJS.ProcessEnv = process.env,
): LineSecretSourceKind {
  const requested = environment.LINE_SECRET_SOURCE?.trim() || 'keychain';
  if (!(LINE_SECRET_SOURCES as readonly string[]).includes(requested)) {
    throw new LinePilotRuntimeError('SECRET_SOURCE_UNKNOWN');
  }
  return requested as LineSecretSourceKind;
}

function gitProvenance(repositoryRoot: string): LinePilotProvenance {
  const git = (arguments_: string[]) =>
    execFileSync('git', arguments_, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  const commitSha = git(['rev-parse', 'HEAD']);
  return {
    commitSha,
    assertFinalMain(expected) {
      if (git(['status', '--porcelain', '--untracked-files=no']) !== '') {
        throw new LinePilotRuntimeError('NOT_FINAL_MAIN');
      }
      if (commitSha !== (expected ?? git(['rev-parse', 'origin/main']))) {
        throw new LinePilotRuntimeError('NOT_FINAL_MAIN');
      }
    },
    migrationsDir: resolve(repositoryRoot, 'packages/db/prisma/migrations'),
    registryPath: resolve(repositoryRoot, 'scripts/cxa-s2-readiness.mjs'),
  };
}

function releaseProvenance(environment: NodeJS.ProcessEnv): LinePilotProvenance {
  const commitSha = environment.DCONTACT_BUILD_SHA ?? '';
  if (!SHA.test(commitSha)) throw new LinePilotRuntimeError('RELEASE_SHA_INVALID');
  const migrationsDir = environment.LINE_PILOT_MIGRATIONS_DIR;
  const registryPath = environment.LINE_PILOT_REGISTRY_PATH;
  if (!migrationsDir || !registryPath) throw new LinePilotRuntimeError('PATH_REQUIRED');
  return {
    commitSha,
    // the image does not know where origin/main is — it can only check that it matches the SHA the commander expected (if given)
    // REG01/marker re-checks that it is the same final-main SHA as another layer
    assertFinalMain(expected) {
      const required = expected ?? environment.CXA_S2_EXPECTED_COMMIT_SHA;
      if (required && required !== commitSha) throw new LinePilotRuntimeError('NOT_FINAL_MAIN');
    },
    migrationsDir,
    registryPath,
  };
}

export function resolveLinePilotRuntime(
  options: {
    environment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    cwd?: string;
  } = {},
): LinePilotRuntime {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const kind = linePilotSecretSourceKind(environment);

  if (kind === 'keychain') {
    if (platform !== 'darwin') throw new LinePilotRuntimeError('PLATFORM_MISMATCH');
    const repositoryRoot = resolve(options.cwd ?? process.cwd(), '../..');
    const stateDir =
      environment.LINE_PILOT_STATE_DIR ?? resolve(repositoryRoot, 'artifacts/cxa-s2/pilot');
    return {
      kind,
      source: new KeychainLineSecretSource(),
      writer: new KeychainLineSecretWriter(),
      stateDir,
      bundleDir:
        environment.CXA_S2_PROVIDER_BUNDLE_DIR ??
        resolve(repositoryRoot, 'artifacts/cxa-s2/provider'),
      provenance: () => gitProvenance(repositoryRoot),
    };
  }

  const stateDir = environment.LINE_PILOT_STATE_DIR;
  if (!stateDir) throw new LinePilotRuntimeError('PATH_REQUIRED');
  const fileOptions = {
    channelAccountId: LINE_PILOT_CHANNEL_ACCOUNT_ID,
    stateDir,
    ...(environment.LINE_CREDENTIAL_DIR ? { secretDir: environment.LINE_CREDENTIAL_DIR } : {}),
  };
  return {
    kind,
    source: new FileLineSecretSource(fileOptions),
    writer: new FileLineSecretWriter(fileOptions),
    stateDir,
    bundleDir: environment.CXA_S2_PROVIDER_BUNDLE_DIR ?? resolve(stateDir, 'provider'),
    provenance: () => releaseProvenance(environment),
  };
}

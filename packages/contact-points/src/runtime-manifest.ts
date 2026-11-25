import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  C360_EMAIL_NORMALIZATION_VERSION,
  C360_PHONE_NORMALIZATION_VERSION,
  C360_TAG_NORMALIZATION_VERSION,
} from './normalize.js';

/**
 * E1 C: release manifest of the parser runtime (Node only; never imported on the browser side)
 * checks that the package actually loaded matches the pinned version and the phone metadata is unchanged
 */
export const C360_PINNED_PARSER_PACKAGES = {
  'libphonenumber-js': '1.13.15',
  'email-addresses': '5.0.0',
  tr46: '5.1.1',
  'unicode-case-folding': '1.1.1',
} as const;

export const C360_PHONE_METADATA_SHA256 =
  '197aabc11a950b88234f2eb20b8259cffa09e975b3ebe90bdd10badefd91dee4';

export interface C360ContactPointRuntimeManifest {
  nodeVersion: string;
  normalizationVersions: { phone: string; email: string; tag: string };
  packages: Record<string, string>;
  phoneMetadataSha256: string;
}

const require = createRequire(import.meta.url);

function installedVersion(name: string): string {
  // the dependency's package.json sits next to the resolved entry and does not rely on the package's exports map
  let directory = require.resolve(name).replace(/\\/g, '/');
  for (;;) {
    directory = directory.slice(0, directory.lastIndexOf('/'));
    try {
      const manifest = JSON.parse(readFileSync(`${directory}/package.json`, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (manifest.name === name && manifest.version) return manifest.version;
    } catch {
      // have not reached the package root yet
    }
    if (!directory.includes('/')) throw new Error(`package.json not found for ${name}`);
  }
}

export function c360ContactPointRuntimeManifest(): C360ContactPointRuntimeManifest {
  const metadata = readFileSync(require.resolve('libphonenumber-js/metadata.max.json'));
  return {
    nodeVersion: process.version,
    normalizationVersions: {
      phone: C360_PHONE_NORMALIZATION_VERSION,
      email: C360_EMAIL_NORMALIZATION_VERSION,
      tag: C360_TAG_NORMALIZATION_VERSION,
    },
    packages: Object.fromEntries(
      Object.keys(C360_PINNED_PARSER_PACKAGES).map((name) => [name, installedVersion(name)]),
    ),
    phoneMetadataSha256: createHash('sha256').update(metadata).digest('hex'),
  };
}

/** fail closed: a runtime that does not match the pinned version must not create new keys */
export function assertC360ContactPointRuntime(): C360ContactPointRuntimeManifest {
  const manifest = c360ContactPointRuntimeManifest();
  for (const [name, version] of Object.entries(C360_PINNED_PARSER_PACKAGES)) {
    if (manifest.packages[name] !== version)
      throw new Error(`${name} must be ${version} but runtime is ${manifest.packages[name]}`);
  }
  if (manifest.phoneMetadataSha256 !== C360_PHONE_METADATA_SHA256)
    throw new Error('phone metadata does not match the SHA256 pinned in E1');
  return manifest;
}

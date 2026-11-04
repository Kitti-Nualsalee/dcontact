import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  C360_EMAIL_NORMALIZATION_VERSION,
  C360_PHONE_NORMALIZATION_VERSION,
  C360_TAG_NORMALIZATION_VERSION,
} from './normalize.js';

/**
 * E1 C: release manifest ของ parser runtime (Node เท่านั้น ไม่ import ฝั่ง browser)
 * ตรวจว่า package ที่โหลดจริงตรงกับรุ่นที่ pin และ metadata ของเบอร์โทรไม่ถูกเปลี่ยน
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
  // package.json ของ dependency อยู่ข้าง entry ที่ resolve ได้ ไม่พึ่ง exports map ของ package
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
      // ยังไม่ถึง root ของ package
    }
    if (!directory.includes('/')) throw new Error(`ไม่พบ package.json ของ ${name}`);
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

/** fail closed: runtime ที่ไม่ตรงกับรุ่น pin ห้ามสร้าง key ใหม่ */
export function assertC360ContactPointRuntime(): C360ContactPointRuntimeManifest {
  const manifest = c360ContactPointRuntimeManifest();
  for (const [name, version] of Object.entries(C360_PINNED_PARSER_PACKAGES)) {
    if (manifest.packages[name] !== version)
      throw new Error(`${name} ต้องเป็น ${version} แต่ runtime เป็น ${manifest.packages[name]}`);
  }
  if (manifest.phoneMetadataSha256 !== C360_PHONE_METADATA_SHA256)
    throw new Error('phone metadata ไม่ตรงกับ SHA256 ที่ pin ใน E1');
  return manifest;
}

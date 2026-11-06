import { assertC360ContactPointRuntime } from '@d-contact/contact-points/runtime-manifest';

export const CUSTOMER_360_WRITE_RUNTIME = Symbol('CUSTOMER_360_WRITE_RUNTIME');
export interface C360WriteRuntime {
  readonly ready: boolean;
}

/** ค่า integrity จาก pnpm-lock.yaml; เปลี่ยนเฉพาะพร้อม parser upgrade และ collision review */
export const C360_PARSER_INTEGRITY: Readonly<Record<string, string>> = Object.freeze({
  'libphonenumber-js@1.13.15':
    'sha512-AHdhEQeDFEJ4GKDAQ9AwxChy+v2kUILUB3TGQRpkXMkWePjXTU/WQEzWVQoIx/Gz8fE73Wr5SEuZCy2vk8jrMQ==',
  'email-addresses@5.0.0':
    'sha512-4OIPYlA6JXqtVn8zpHpGiI7vE6EQOAg16aGnDMIAlZVinnoZ8208tW1hAbjWydgN/4PLTT9q+O1K6AH/vALJGw==',
  'tr46@5.1.1':
    'sha512-hdF5ZgjTqgAntKkklYw0R03MG2x/bSzTtkxmIRw/sTNV8YXsCJ1tfLAX23lhxhHJlEf3CRCOCGGWw3vI3GaSPw==',
  'punycode@2.3.1':
    'sha512-vYt7UD1U9Wg6138shLtLOvdAu+8DsC/ilFtEVHcH+wydcSpNE20AfSOduf6MkRFahL5FY7X1oU7nKVZFtfq8Fg==',
  'unicode-case-folding@1.1.1':
    'sha512-ZAYziAnMTBisO2dT5tyGvBFMNsIfonOS/BZTd3UZaKWtXMOZqK8s8HRUCrlKxGCTeCxCuCjS/6HW+4a6G+rbzw==',
});

/**
 * ตรวจ parser ที่โหลดจริงตอนเริ่ม API; production ต้องมี release manifest ที่ตรง image digest,
 * Node/ICU/Unicode, normalization versions, metadata hash และ lockfile integrity ด้วย
 * ค่า digest ต้องมาจาก deployment metadata ที่ผู้ดูแล release ตรวจสอบ ไม่ใช่ attestation ของตัว image เอง
 */
export function createC360WriteRuntime(env: NodeJS.ProcessEnv = process.env): C360WriteRuntime {
  try {
    const actual = assertC360ContactPointRuntime();
    if (env.NODE_ENV !== 'production') return { ready: true };
    const release = JSON.parse(env.C360_WRITE_RELEASE_MANIFEST ?? 'null') as {
      imageDigest?: unknown;
      nodeVersion?: unknown;
      icuVersion?: unknown;
      unicodeVersion?: unknown;
      phoneMetadataSha256?: unknown;
      normalizationVersions?: Record<string, unknown>;
      packageIntegrity?: Record<string, unknown>;
    } | null;
    if (
      !release ||
      typeof release.imageDigest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(release.imageDigest) ||
      release.imageDigest !== env.C360_IMAGE_DIGEST ||
      release.nodeVersion !== actual.nodeVersion ||
      release.icuVersion !== process.versions.icu ||
      release.unicodeVersion !== process.versions.unicode ||
      release.phoneMetadataSha256 !== actual.phoneMetadataSha256
    )
      return { ready: false };
    if (
      Object.entries(actual.normalizationVersions).some(
        ([key, value]) => release.normalizationVersions?.[key] !== value,
      )
    )
      return { ready: false };
    if (
      Object.entries(C360_PARSER_INTEGRITY).some(
        ([key, value]) => release.packageIntegrity?.[key] !== value,
      )
    )
      return { ready: false };
    return { ready: true };
  } catch {
    return { ready: false };
  }
}

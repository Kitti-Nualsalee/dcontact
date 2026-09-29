/**
 * config ของ object storage ตาม ADR-029: แอปคุยกับ storage ผ่าน S3 API และอ่าน env ชุดเดียว `S3_*`
 * ชื่อเดิม (`MINIO_*` และชื่อ bucket env เดิม) ยังอ่านได้ช่วงเปลี่ยนผ่าน พร้อมเตือนว่า deprecated
 */

export interface S3Configuration {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** env ที่ helper อ่าน: `process.env` หรือ object ที่ test ส่งเข้ามา */
export type S3Environment = Readonly<Record<string, string | undefined>>;

export type S3Bucket = 'RECORDINGS' | 'GOVERNANCE_EXPORTS' | 'UAT_EVIDENCE';

export interface ReadS3ConfigurationOptions {
  environment?: S3Environment;
  /**
   * true = endpoint และ credential ต้องมาจาก env เสมอ (ไม่มีค่า default ของ dev)
   * ค่าเริ่มต้นคือ true เมื่อ `NODE_ENV=production`
   */
  requireExplicit?: boolean;
  /** ข้อความเมื่อไม่มีค่าที่ต้องมี เช่น "for UAT evidence storage" */
  purpose?: string;
  warn?: (message: string) => void;
}

/** ค่า default ของ dev ตรงกับ `infra/docker/docker-compose.dev.yml` และ `.env.example` */
const DEV_DEFAULTS = {
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'dcontact',
  S3_SECRET_KEY: 'dcontact-secret',
} as const;

const BUCKETS: Record<S3Bucket, { legacy: string; fallback: string }> = {
  RECORDINGS: { legacy: 'RECORDINGS_BUCKET', fallback: 'recordings' },
  GOVERNANCE_EXPORTS: { legacy: 'GOVERNANCE_EXPORTS_BUCKET', fallback: 'governance-exports' },
  UAT_EVIDENCE: { legacy: 'UAT_EVIDENCE_BUCKET', fallback: 'uat-evidence' },
};

const warned = new Set<string>();

function defaultWarn(message: string): void {
  console.warn(message);
}

function read(
  environment: S3Environment,
  name: string,
  legacyNames: readonly string[],
  warn: (message: string) => void,
): string | undefined {
  const value = environment[name]?.trim();
  if (value) return value;
  for (const legacy of legacyNames) {
    const legacyValue = environment[legacy]?.trim();
    if (!legacyValue) continue;
    if (!warned.has(legacy)) {
      warned.add(legacy);
      warn(`${legacy} is deprecated; use ${name} instead (ADR-029)`);
    }
    return legacyValue;
  }
  return undefined;
}

export function readS3Configuration(options: ReadS3ConfigurationOptions = {}): S3Configuration {
  const environment = options.environment ?? process.env;
  const warn = options.warn ?? defaultWarn;
  const requireExplicit = options.requireExplicit ?? environment.NODE_ENV === 'production';
  const suffix = options.purpose ? ` ${options.purpose}` : '';

  const value = (name: keyof typeof DEV_DEFAULTS, legacyNames: readonly string[]): string => {
    const found = read(environment, name, legacyNames, warn);
    if (found) return found;
    if (requireExplicit) throw new Error(`${name} is required${suffix}`);
    return DEV_DEFAULTS[name];
  };

  return {
    endpoint: value('S3_ENDPOINT', ['MINIO_ENDPOINT']),
    region: read(environment, 'S3_REGION', ['MINIO_REGION'], warn) ?? 'us-east-1',
    accessKeyId: value('S3_ACCESS_KEY', ['MINIO_ACCESS_KEY']),
    secretAccessKey: value('S3_SECRET_KEY', ['MINIO_SECRET_KEY']),
    forcePathStyle: environment.S3_FORCE_PATH_STYLE?.trim().toLowerCase() !== 'false',
  };
}

export function readS3Bucket(
  bucket: S3Bucket,
  environment: S3Environment = process.env,
  warn: (message: string) => void = defaultWarn,
): string {
  const { legacy, fallback } = BUCKETS[bucket];
  return read(environment, `S3_BUCKET_${bucket}`, [legacy], warn) ?? fallback;
}

/** สำหรับ test เท่านั้น: ให้เตือน deprecated ได้อีกครั้ง */
export function resetS3DeprecationWarnings(): void {
  warned.clear();
}

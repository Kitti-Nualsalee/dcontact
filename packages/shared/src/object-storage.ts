/**
 * object storage config per ADR-029: apps talk to storage through the S3 API and read a single env set `S3_*`
 * the legacy names (`MINIO_*` and the old bucket env names) are still read during the transition, with a deprecation warning
 */

export interface S3Configuration {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** env the helper reads: `process.env` or an object passed in by a test */
export type S3Environment = Readonly<Record<string, string | undefined>>;

export type S3Bucket = 'RECORDINGS' | 'GOVERNANCE_EXPORTS' | 'UAT_EVIDENCE';

export interface ReadS3ConfigurationOptions {
  environment?: S3Environment;
  /**
   * true = endpoint and credential must always come from env (no dev defaults)
   * defaults to true when `NODE_ENV=production`
   */
  requireExplicit?: boolean;
  /** message when a required value is missing, e.g. "for UAT evidence storage" */
  purpose?: string;
  warn?: (message: string) => void;
}

/** dev defaults match `infra/docker/docker-compose.dev.yml` and `.env.example` */
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

/** test only: allows the deprecation warning to fire again */
export function resetS3DeprecationWarnings(): void {
  warned.clear();
}

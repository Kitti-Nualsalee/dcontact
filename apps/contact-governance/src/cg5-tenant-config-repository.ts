import {
  Prisma,
  withTenantDatabaseTransaction,
  type Cg5TenantConfig,
  type PrismaClient,
} from '@d-contact/db';
import {
  CG5_CONFIG_BOUNDS,
  CG5_CONTRACT_VERSION,
  CG5_DEFAULT_TENANT_CONFIG,
  assertCg5TenantConfig,
  cg5ConfigDigest,
  type Cg5TenantConfigV1,
} from '@d-contact/cxa-contracts';
import { Cg3VersionConflictError } from './cg3-persistence.js';

export interface Cg5TenantConfigSnapshot {
  tenantId: string;
  config: Cg5TenantConfigV1;
  version: number;
  updatedByRef: string | null;
  evidenceRef: string | null;
  updatedAt: Date | null;
}

export interface UpdateCg5TenantConfigInput {
  /** tenant จาก trusted caller; repository ไม่ใช่ authorization boundary ของ HTTP */
  tenantId: string;
  expectedVersion: number;
  config: Cg5TenantConfigV1;
  actorRef: string;
  evidenceRef: string;
}

function validatedConfig(value: unknown): Cg5TenantConfigV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('config ต้องเป็น object');
  }
  const input = value as Record<string, unknown>;
  if (input.contractVersion !== CG5_CONTRACT_VERSION) {
    throw new TypeError('config ต้องใช้ contractVersion 1');
  }
  const allowed = new Set(['contractVersion', ...Object.keys(CG5_CONFIG_BOUNDS)]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new TypeError('config มี field ที่ไม่ได้ประกาศใน contract');
  }
  // validator ของ shared contract ตรวจชนิด number และช่วงค่าทุก field
  assertCg5TenantConfig(input);
  return { ...input, contractVersion: CG5_CONTRACT_VERSION };
}

function snapshot(tenantId: string, row: Cg5TenantConfig | null): Cg5TenantConfigSnapshot {
  return {
    tenantId,
    config: row ? validatedConfig(row.config) : { ...CG5_DEFAULT_TENANT_CONFIG },
    version: row?.version ?? 0,
    updatedByRef: row?.updatedByRef ?? null,
    evidenceRef: row?.evidenceRef ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

export class PrismaCg5TenantConfigRepository {
  constructor(
    private readonly database: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  read(tenantId: string): Promise<Cg5TenantConfigSnapshot> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) =>
      snapshot(tenantId, await transaction.cg5TenantConfig.findUnique({ where: { tenantId } })),
    );
  }

  async update(input: UpdateCg5TenantConfigInput): Promise<Cg5TenantConfigSnapshot> {
    const config = validatedConfig(input.config);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new TypeError('expectedVersion ต้องเป็นจำนวนเต็มที่ไม่ติดลบ');
    }
    const actorRef = input.actorRef.trim();
    const evidenceRef = input.evidenceRef.trim();
    if (!actorRef || !evidenceRef) throw new TypeError('actorRef และ evidenceRef ต้องไม่ว่าง');
    const result = await withTenantDatabaseTransaction(
      this.database,
      input.tenantId,
      async (tx) => {
        // serialize รวมการสร้างแถวแรก เพื่อให้คำสั่งที่ชนกันยังเก็บ conflict audit ได้
        await tx.$queryRaw(
          Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`cg5-config:${input.tenantId}`}))`,
        );
        const current = snapshot(
          input.tenantId,
          await tx.cg5TenantConfig.findUnique({ where: { tenantId: input.tenantId } }),
        );
        const conflict = current.version !== input.expectedVersion;
        const occurredAt = this.now();
        const nextVersion = conflict ? current.version : current.version + 1;
        const beforeDigest = cg5ConfigDigest(current.config);
        const requestedDigest = cg5ConfigDigest(config);
        await tx.cg5TenantConfigAudit.create({
          data: {
            tenantId: input.tenantId,
            action: conflict ? 'VERSION_CONFLICT' : current.version === 0 ? 'CREATED' : 'UPDATED',
            expectedVersion: input.expectedVersion,
            actualVersion: current.version,
            resultingVersion: nextVersion,
            beforeDigest,
            requestedDigest,
            afterDigest: conflict ? beforeDigest : requestedDigest,
            actorRef,
            evidenceRef,
            occurredAt,
          },
        });
        if (conflict) return { conflict: true as const, actualVersion: current.version };
        const data = {
          config: { ...config },
          version: nextVersion,
          updatedByRef: actorRef,
          evidenceRef,
          updatedAt: occurredAt,
        };
        const row = await tx.cg5TenantConfig.upsert({
          where: { tenantId: input.tenantId },
          create: { tenantId: input.tenantId, ...data },
          update: data,
        });
        return { conflict: false as const, snapshot: snapshot(input.tenantId, row) };
      },
    );
    // throw หลัง commit เพื่อไม่ rollback หลักฐานของคำสั่งที่ชน version
    if (result.conflict) {
      throw new Cg3VersionConflictError(input.expectedVersion, result.actualVersion);
    }
    return result.snapshot;
  }
}

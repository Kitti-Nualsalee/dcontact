/**
 * U1.8 (#502) — CLI ของ UAT operator: provision tenant, owner team, บัญชี maker/reviewer (แถว `users` +
 * `iam_authoring_subjects` + TEAM grant), rollout ของ Journey authoring และ fixture pack (`UatFixturePackV1`)
 *
 * Authority: Phase Contract #374, fixture/reset #376, boundary #378; แทนขั้น `psql` ด้วยมือใน runbook U1.6 ข้อ 5
 *
 * - อ่านไฟล์ input `schema: 'UatProvisionV1'` แบบ strict (key ที่ไม่รู้จัก = ปฏิเสธ) ไม่มีค่า default ของ
 *   credential/PII ใด ๆ — ทุกค่ามาจาก operator
 * - ใช้ connection ของ owner/operator (`DATABASE_URL`) เท่านั้น: `current_user` เป็น role ของ application
 *   (`dcontact_app` ฯลฯ) = ปฏิเสธก่อนอ่าน/เขียนข้อมูลใด ๆ
 * - ข้อ 1–4 ทำใน transaction เดียวแบบ idempotent: ไม่มี = CREATED, ตรงกับ input = UNCHANGED, มีแต่ต่างจาก
 *   input = fail closed (ไม่เขียนทับ) แล้วจึงเรียก `UatFixtureProvisioner.provision()` เดิมของ U1.1
 *   (digest ต่าง = `FIXTURE_PACK_DIGEST_MISMATCH`)
 * - ก่อนเขียนอะไร: negative scan (`scanUatText` ของ U1.5) ครอบทั้ง input + manifest **ยกเว้นเฉพาะ**
 *   `maker.email`/`reviewer.email` ซึ่งเป็นอีเมลจริงของผู้ทดสอบโดยชอบ (field อื่นมีอีเมล/token = ปฏิเสธ)
 * - placeholder `__UAT_*__` ของ example/template ที่ยังไม่กรอก (`INPUT_PLACEHOLDER`) และ stub
 *   `fixturePack.template` ที่ยังไม่ผ่าน `scripts/u1-uat-fixture-render.mjs` (`FIXTURE_PACK_NOT_RENDERED`)
 *   ถูกปฏิเสธก่อน scan/ฐานข้อมูล (U1.9 #506)
 * - `--check`: validate + preflight เดียวกันใน transaction แบบ READ ONLY — ไม่เขียนเลย
 * - output เป็น JSON lines ที่มีแค่ id/สถานะ/digest/รหัสข้อผิดพลาด — ไม่พิมพ์อีเมล ชื่อ หรือ `DATABASE_URL`
 * - ไม่สร้าง credential ของ Keycloak (เป็นงานของ `scripts/u1-uat-keycloak-users.mjs`), ไม่ใช้ dev seed
 *   และไม่ใช่ API — รันเป็น one-shot ใน ops image เท่านั้น
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PrismaClient, type Prisma } from '@d-contact/db';
import {
  UAT_MAKER_CAPABILITIES,
  UAT_REVIEWER_CAPABILITIES,
  UatFixtureProvisioner,
  UatRunError,
  parseUatFixturePackManifest,
  scanUatText,
  type UatFixturePackManifestV1,
} from '@d-contact/journey';

type Tx = Prisma.TransactionClient;

export const UAT_PROVISION_SCHEMA = 'UatProvisionV1';
/** slug/ชื่อ tenant ของ `pnpm db:seed` (packages/db/prisma/seed.ts, scripts/phase-one-tenants.mjs) */
export const DEV_SEED_TENANT_SLUGS = Object.freeze(['demo', 'demo-two']);
const DEV_SEED_TENANT_NAMES = Object.freeze(['Demo Company', 'Demo Company Two']);
/** บัญชี seed ของ dev ใช้โดเมน `.local` (เช่น `admin@demo.local`) — เหมือน u1-uat-keycloak-users.mjs */
const DEV_ACCOUNT_DOMAIN = /\.local$/i;
/** role ของ application ใน rls.sql — ห้ามใช้ provision (ต้องเป็น owner/operator) */
export const UAT_PROVISION_REFUSED_ROLES = Object.freeze([
  'dcontact_app',
  'dcontact_platform',
  'dcontact_provisioner',
]);
/** users ของ UAT login ผ่าน Keycloak เท่านั้น — ไม่มี password hash ในฐานข้อมูล (แนวเดียวกับ A1 provisioning) */
export const KEYCLOAK_MANAGED_PASSWORD = '!keycloak-managed';
const PROVISIONED_BY_REF = 'u1-uat-provision';
const ROLLOUT_STAGES = ['INTERNAL_SYNTHETIC', 'SELECTED_TENANT', 'CONTROLLED_AUTHORING'] as const;
type RolloutStage = (typeof ROLLOUT_STAGES)[number];

// ── Errors ────────────────────────────────────────────────────────────────

export type UatProvisionErrorCode =
  | 'USAGE'
  | 'INPUT_UNREADABLE'
  | 'INPUT_INVALID'
  | 'INPUT_SENSITIVE_CONTENT'
  | 'INPUT_PLACEHOLDER'
  | 'FIXTURE_PACK_NOT_RENDERED'
  | 'MAKER_REVIEWER_SAME'
  | 'DEV_SEED_REFUSED'
  | 'TENANT_ENV_MISMATCH'
  | 'DATABASE_URL_MISSING'
  | 'APPLICATION_ROLE_REFUSED'
  | 'TENANT_CONFLICT'
  | 'OWNER_TEAM_CONFLICT'
  | 'ROLLOUT_CONFLICT'
  | 'USER_CONFLICT'
  | 'SUBJECT_CONFLICT'
  | 'GRANTS_CONFLICT';

export class UatProvisionError extends Error {
  constructor(
    readonly code: UatProvisionErrorCode,
    /** ชื่อ field/part/ชนิดเท่านั้น — ห้ามใส่ค่าจาก input */
    readonly safeParams: Readonly<Record<string, string>> = {},
  ) {
    super(`uat provision: ${code}`);
    this.name = 'UatProvisionError';
  }
}

// ── Input ─────────────────────────────────────────────────────────────────

export interface UatProvisionAccountV1 {
  readonly dcUserId: string;
  readonly email: string;
  readonly displayName: string;
}

export interface UatProvisionInputV1 {
  readonly schema: typeof UAT_PROVISION_SCHEMA;
  readonly tenant: { readonly id: string; readonly slug: string; readonly name: string };
  readonly ownerTeam: { readonly id: string; readonly name: string };
  readonly maker: UatProvisionAccountV1;
  readonly reviewer: UatProvisionAccountV1;
  readonly rollout: {
    readonly stage: RolloutStage;
    readonly canvasWriteEnabled: true;
    readonly publishUiEnabled: true;
    readonly templateCatalogEnabled: boolean;
    readonly templateUpgradeEnabled: boolean;
    readonly evidenceRef: string;
  };
  readonly fixturePack: UatFixturePackManifestV1;
}

// UUID ตัวพิมพ์เล็กเท่านั้น: `subjectId` ของ J5 เป็น string — ต้องตรงกับ manifest แบบตัวอักษรต่อตัวอักษร
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,}$/;
// ข้อความอิสระ: ไม่มี control character, ไม่เป็นช่องว่างล้วน
// eslint-disable-next-line no-control-regex
const FREE_TEXT = /^(?=[\s\S]*\S)[^\u0000-\u001f\u007f]{1,200}$/;

function invalid(field: string): never {
  throw new UatProvisionError('INPUT_INVALID', { field });
}

/** object ที่มี key ครบตาม `keys` และไม่มี key อื่น */
function strict(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  const entries = value as Record<string, unknown>;
  for (const key of Object.keys(entries)) {
    if (!keys.includes(key)) invalid(field ? `${field}.${key}` : key);
  }
  for (const key of keys) {
    if (!(key in entries)) invalid(field ? `${field}.${key}` : key);
  }
  return entries;
}

function text(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(field);
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field);
  return value;
}

/**
 * negative scan ของ U1.5 ก่อนเขียนใด ๆ — ครอบทุก field รวม manifest ยกเว้นอีเมลของ maker/reviewer
 * (อีเมลจริงของผู้ทดสอบเป็นข้อมูลที่ต้องมีโดยชอบ; รูปแบบของอีเมลตรวจแยกใน `parseAccount`)
 */
export function scanUatProvisionInput(raw: Record<string, unknown>, manifest: unknown): void {
  const redacted: Record<string, unknown> = { ...raw, fixturePack: manifest };
  delete redacted.fixturePackPath;
  for (const role of ['maker', 'reviewer'] as const) {
    const account = raw[role];
    if (account && typeof account === 'object' && !Array.isArray(account)) {
      redacted[role] = { ...(account as Record<string, unknown>), email: '<redacted>' };
    }
  }
  const [kind] = scanUatText(JSON.stringify(redacted));
  if (kind) throw new UatProvisionError('INPUT_SENSITIVE_CONTENT', { kind });
}

/** placeholder ของ `infra/uat/uat-provision.example.json` และ fixture template (U1.9 #506) */
export const UAT_PROVISION_PLACEHOLDER = /__UAT_[A-Z0-9_]+__/;

/** path ของ string แรกที่ยังเป็น placeholder — ชื่อ field เท่านั้น ไม่มีค่า */
function placeholderField(value: unknown, path: string): string | null {
  if (typeof value === 'string') return UAT_PROVISION_PLACEHOLDER.test(value) ? path : null;
  if (!value || typeof value !== 'object') return null;
  for (const [key, entry] of Object.entries(value)) {
    const found = placeholderField(entry, path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return null;
}

function parseAccount(value: unknown, role: 'maker' | 'reviewer'): UatProvisionAccountV1 {
  const account = strict(value, role, ['dcUserId', 'email', 'displayName']);
  const email = text(account.email, `${role}.email`, EMAIL);
  if (email.length > 254) invalid(`${role}.email`);
  if (DEV_ACCOUNT_DOMAIN.test(email)) {
    throw new UatProvisionError('DEV_SEED_REFUSED', { field: `${role}.email` });
  }
  return {
    dcUserId: text(account.dcUserId, `${role}.dcUserId`, UUID),
    email,
    displayName: text(account.displayName, `${role}.displayName`, FREE_TEXT),
  };
}

export interface ParseUatProvisionOptions {
  /** โฟลเดอร์ของไฟล์ input — `fixturePackPath` แบบ relative อ้างจากที่นี่ */
  readonly baseDirectory?: string;
  /** `UAT_TENANT_ID`/`UAT_TENANT_SLUG` ของ uat.env — ถ้ามีต้องตรงกับ input */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly readFile?: (path: string) => string;
}

export function parseUatProvisionInput(
  value: unknown,
  options: ParseUatProvisionOptions = {},
): UatProvisionInputV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('input');
  const raw = value as Record<string, unknown>;
  const byPath = 'fixturePackPath' in raw;
  if (byPath === 'fixturePack' in raw) invalid('fixturePack');
  const input = strict(raw, '', [
    'schema',
    'tenant',
    'ownerTeam',
    'maker',
    'reviewer',
    'rollout',
    byPath ? 'fixturePackPath' : 'fixturePack',
  ]);
  if (input.schema !== UAT_PROVISION_SCHEMA) invalid('schema');

  let manifestValue: unknown = input.fixturePack;
  if (byPath) {
    const path = text(input.fixturePackPath, 'fixturePackPath', /^[^\u0000]{1,1024}$/);
    const read = options.readFile ?? ((file: string) => readFileSync(file, 'utf8'));
    try {
      manifestValue = JSON.parse(read(resolve(options.baseDirectory ?? process.cwd(), path)));
    } catch {
      throw new UatProvisionError('INPUT_UNREADABLE', { field: 'fixturePackPath' });
    }
  }
  // U1.9 (#506): example/template ที่ยังไม่กรอก หรือ stub ของ fixture pack ที่ยังไม่ render = ปฏิเสธทันที
  // (field อิสระอย่างชื่อ tenant รับ `__UAT_…__` ได้ตามรูปแบบ จึงต้องดักตรงนี้)
  const placeholder = placeholderField({ ...raw, fixturePack: manifestValue }, '');
  if (placeholder) throw new UatProvisionError('INPUT_PLACEHOLDER', { field: placeholder });
  if (
    manifestValue &&
    typeof manifestValue === 'object' &&
    !Array.isArray(manifestValue) &&
    'template' in manifestValue
  ) {
    throw new UatProvisionError('FIXTURE_PACK_NOT_RENDERED', { field: 'fixturePack.template' });
  }
  // scan ก่อน validate รายละเอียด — ค่าต้องห้ามไม่ถูกสะท้อนใน error ใด ๆ และไม่ไปถึงฐานข้อมูล
  scanUatProvisionInput(raw, manifestValue);

  const tenantValue = strict(input.tenant, 'tenant', ['id', 'slug', 'name']);
  const tenant = {
    id: text(tenantValue.id, 'tenant.id', UUID),
    slug: text(tenantValue.slug, 'tenant.slug', SLUG),
    name: text(tenantValue.name, 'tenant.name', FREE_TEXT),
  };
  if (DEV_SEED_TENANT_SLUGS.includes(tenant.slug)) {
    throw new UatProvisionError('DEV_SEED_REFUSED', { field: 'tenant.slug' });
  }
  if (DEV_SEED_TENANT_NAMES.includes(tenant.name)) {
    throw new UatProvisionError('DEV_SEED_REFUSED', { field: 'tenant.name' });
  }
  const environment = options.environment ?? {};
  if (environment.UAT_TENANT_ID && environment.UAT_TENANT_ID !== tenant.id) {
    throw new UatProvisionError('TENANT_ENV_MISMATCH', { field: 'tenant.id' });
  }
  if (environment.UAT_TENANT_SLUG && environment.UAT_TENANT_SLUG !== tenant.slug) {
    throw new UatProvisionError('TENANT_ENV_MISMATCH', { field: 'tenant.slug' });
  }

  const teamValue = strict(input.ownerTeam, 'ownerTeam', ['id', 'name']);
  const ownerTeam = {
    id: text(teamValue.id, 'ownerTeam.id', UUID),
    name: text(teamValue.name, 'ownerTeam.name', FREE_TEXT),
  };

  const maker = parseAccount(input.maker, 'maker');
  const reviewer = parseAccount(input.reviewer, 'reviewer');
  // maker-checker ต้องเป็นคนละบัญชี (#372)
  if (maker.dcUserId === reviewer.dcUserId) {
    throw new UatProvisionError('MAKER_REVIEWER_SAME', { field: 'dcUserId' });
  }
  if (maker.email.toLowerCase() === reviewer.email.toLowerCase()) {
    throw new UatProvisionError('MAKER_REVIEWER_SAME', { field: 'email' });
  }

  const rolloutValue = strict(input.rollout, 'rollout', [
    'stage',
    'canvasWriteEnabled',
    'publishUiEnabled',
    'templateCatalogEnabled',
    'templateUpgradeEnabled',
    'evidenceRef',
  ]);
  const stage = rolloutValue.stage as RolloutStage;
  if (!ROLLOUT_STAGES.includes(stage)) invalid('rollout.stage');
  // preflight ของ fixture pack ต้องการ canvas write + publish UI เปิด — ค่าอื่นเท่ากับ fail แน่นอน
  if (rolloutValue.canvasWriteEnabled !== true) invalid('rollout.canvasWriteEnabled');
  if (rolloutValue.publishUiEnabled !== true) invalid('rollout.publishUiEnabled');
  const rollout = {
    stage,
    canvasWriteEnabled: true as const,
    publishUiEnabled: true as const,
    templateCatalogEnabled: bool(
      rolloutValue.templateCatalogEnabled,
      'rollout.templateCatalogEnabled',
    ),
    templateUpgradeEnabled: bool(
      rolloutValue.templateUpgradeEnabled,
      'rollout.templateUpgradeEnabled',
    ),
    evidenceRef: text(rolloutValue.evidenceRef, 'rollout.evidenceRef', OPAQUE),
  };

  const fixturePack = parseUatFixturePackManifest(manifestValue);
  // manifest ต้องผูกกับ tenant/team/บัญชีเดียวกับ input — ไม่ยอมให้ pack ชี้ไปที่อื่น
  const bindings: Array<[string, string, string]> = [
    ['fixturePack.tenantId', fixturePack.tenantId, tenant.id],
    ['fixturePack.ownerTeamId', fixturePack.ownerTeamId, ownerTeam.id],
    ['fixturePack.makerSubjectId', fixturePack.makerSubjectId, maker.dcUserId],
    ['fixturePack.reviewerSubjectId', fixturePack.reviewerSubjectId, reviewer.dcUserId],
  ];
  for (const [field, actual, expected] of bindings) {
    if (actual !== expected) invalid(field);
  }

  return {
    schema: UAT_PROVISION_SCHEMA,
    tenant,
    ownerTeam,
    maker,
    reviewer,
    rollout,
    // ส่ง manifest ต้นฉบับต่อให้ provisioner parse/digest เอง (digest ต้องเท่ากับที่ U1.1 คำนวณ)
    fixturePack: manifestValue as UatFixturePackManifestV1,
  };
}

// ── Provisioning ──────────────────────────────────────────────────────────

export type UatProvisionMode = 'apply' | 'check';
export type UatProvisionStatus = 'CREATED' | 'UNCHANGED' | 'WOULD_CREATE';

/** หนึ่งบรรทัดของผล — id/สถานะ/digest เท่านั้น */
export interface UatProvisionPartResult {
  readonly part: string;
  readonly status: UatProvisionStatus;
  readonly [id: string]: string;
}

function uniqueViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002';
}

/** create ที่ชน unique (slug/ชื่อ/อีเมล/sip domain ของแถวอื่น) = conflict ของ part นั้น ไม่ใช่ error ดิบ */
async function create(
  work: () => Promise<unknown>,
  code: UatProvisionErrorCode,
  params: Record<string, string> = {},
) {
  try {
    await work();
  } catch (error) {
    if (uniqueViolation(error)) throw new UatProvisionError(code, params);
    throw error;
  }
}

export class UatProvisioner {
  private readonly fixtures: UatFixtureProvisioner;

  constructor(private readonly database: PrismaClient) {
    this.fixtures = new UatFixtureProvisioner(database);
  }

  /** connection ต้องเป็น owner/operator — role ของ application เขียน tenant/grant/pack ไม่ได้และห้ามใช้ */
  async assertOperatorConnection(): Promise<void> {
    const [row] = await this.database.$queryRaw<Array<{ role: string }>>`
      SELECT current_user::text AS role`;
    if (!row || UAT_PROVISION_REFUSED_ROLES.includes(row.role)) {
      throw new UatProvisionError('APPLICATION_ROLE_REFUSED');
    }
  }

  async run(input: UatProvisionInputV1, mode: UatProvisionMode): Promise<UatProvisionPartResult[]> {
    await this.assertOperatorConnection();
    // plan แบบ READ ONLY ก่อนเสมอ: conflict ใด ๆ (รวม digest ของ pack) = หยุดก่อนเขียนแถวแรก
    const planned = await this.database.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return this.reconcile(tx, input, false);
    });
    const prerequisitesReady = planned.every((part) => part.status === 'UNCHANGED');
    const pack = await this.fixtures.check(input.fixturePack, { preflight: prerequisitesReady });
    if (mode === 'check') {
      return [
        ...planned,
        {
          part: 'fixturePack',
          status: pack.status,
          ...(pack.fixturePackId ? { fixturePackId: pack.fixturePackId } : {}),
          digest: pack.digest,
          preflight: pack.preflight,
        },
      ];
    }
    const applied = await this.database.$transaction((tx) => this.reconcile(tx, input, true));
    const provisioned = await this.fixtures.provision(input.fixturePack);
    return [
      ...applied,
      {
        part: 'fixturePack',
        status: provisioned.status,
        fixturePackId: provisioned.fixturePackId,
        digest: provisioned.digest,
      },
    ];
  }

  /** ข้อ 1–4: ไม่มี = สร้าง (หรือ WOULD_CREATE เมื่อ `write` = false), ตรง = UNCHANGED, ต่าง = fail closed */
  private async reconcile(
    tx: Tx,
    input: UatProvisionInputV1,
    write: boolean,
  ): Promise<UatProvisionPartResult[]> {
    const created: UatProvisionStatus = write ? 'CREATED' : 'WOULD_CREATE';
    const results: UatProvisionPartResult[] = [];
    const { tenant, ownerTeam, rollout } = input;
    const tenantId = tenant.id;

    // 1) tenant
    const existingTenant = await tx.tenant.findUnique({ where: { id: tenantId } });
    if (existingTenant) {
      if (DEV_SEED_TENANT_SLUGS.includes(existingTenant.slug)) {
        throw new UatProvisionError('DEV_SEED_REFUSED', { field: 'tenant.id' });
      }
      if (
        existingTenant.slug !== tenant.slug ||
        existingTenant.name !== tenant.name ||
        existingTenant.lifecycleStatus !== 'ACTIVE'
      ) {
        throw new UatProvisionError('TENANT_CONFLICT', { part: 'tenant' });
      }
      results.push({ part: 'tenant', status: 'UNCHANGED', tenantId });
    } else {
      if (await tx.tenant.findUnique({ where: { slug: tenant.slug }, select: { id: true } })) {
        throw new UatProvisionError('TENANT_CONFLICT', { part: 'tenant', field: 'tenant.slug' });
      }
      if (write) {
        await create(
          () =>
            tx.tenant.create({
              data: {
                id: tenantId,
                slug: tenant.slug,
                name: tenant.name,
                // UAT first slice ไม่มี telephony — sip domain ที่ resolve ไม่ได้ตาม RFC 2606 แต่ยัง unique
                sipDomain: `${tenant.slug}.uat.invalid`,
                lifecycleStatus: 'ACTIVE',
              },
            }),
          'TENANT_CONFLICT',
          { part: 'tenant' },
        );
      }
      results.push({ part: 'tenant', status: created, tenantId });
    }

    // 2a) owner team
    const existingTeam = await tx.team.findUnique({ where: { id: ownerTeam.id } });
    if (existingTeam) {
      if (
        existingTeam.tenantId !== tenantId ||
        existingTeam.name !== ownerTeam.name ||
        !existingTeam.isActive
      ) {
        throw new UatProvisionError('OWNER_TEAM_CONFLICT', { part: 'ownerTeam' });
      }
      results.push({ part: 'ownerTeam', status: 'UNCHANGED', teamId: ownerTeam.id });
    } else {
      const sameName = await tx.team.findUnique({
        where: { tenantId_name: { tenantId, name: ownerTeam.name } },
        select: { id: true },
      });
      if (sameName) {
        throw new UatProvisionError('OWNER_TEAM_CONFLICT', { part: 'ownerTeam', field: 'name' });
      }
      if (write) {
        await create(
          () => tx.team.create({ data: { id: ownerTeam.id, tenantId, name: ownerTeam.name } }),
          'OWNER_TEAM_CONFLICT',
          { part: 'ownerTeam' },
        );
      }
      results.push({ part: 'ownerTeam', status: created, teamId: ownerTeam.id });
    }

    // 4) rollout ของ Journey authoring (flag เชิงหน้าที่ต้องตรง; updatedByRef/evidenceRef เป็น audit ไม่เทียบ)
    const existingRollout = await tx.jrAuthoringRolloutState.findUnique({ where: { tenantId } });
    if (existingRollout) {
      if (
        existingRollout.stage !== rollout.stage ||
        existingRollout.canvasWriteEnabled !== rollout.canvasWriteEnabled ||
        existingRollout.publishUiEnabled !== rollout.publishUiEnabled ||
        existingRollout.templateCatalogEnabled !== rollout.templateCatalogEnabled ||
        existingRollout.templateUpgradeEnabled !== rollout.templateUpgradeEnabled ||
        existingRollout.mutationFrozen
      ) {
        throw new UatProvisionError('ROLLOUT_CONFLICT', { part: 'rollout' });
      }
      results.push({ part: 'rollout', status: 'UNCHANGED', tenantId });
    } else {
      if (write) {
        await create(
          () =>
            tx.jrAuthoringRolloutState.create({
              data: {
                tenantId,
                stage: rollout.stage,
                canvasWriteEnabled: rollout.canvasWriteEnabled,
                publishUiEnabled: rollout.publishUiEnabled,
                templateCatalogEnabled: rollout.templateCatalogEnabled,
                templateUpgradeEnabled: rollout.templateUpgradeEnabled,
                mutationFrozen: false,
                updatedByRef: PROVISIONED_BY_REF,
                evidenceRef: rollout.evidenceRef,
              },
            }),
          'ROLLOUT_CONFLICT',
          { part: 'rollout' },
        );
      }
      results.push({ part: 'rollout', status: created, tenantId });
    }

    const accounts = [
      ['maker', input.maker, UAT_MAKER_CAPABILITIES],
      ['reviewer', input.reviewer, UAT_REVIEWER_CAPABILITIES],
    ] as const;

    // 2b) แถว users ของ maker/reviewer (id = dcUserId = subjectId ของ J5)
    for (const [role, account] of accounts) {
      const part = `user:${role}`;
      const existing = await tx.user.findUnique({ where: { id: account.dcUserId } });
      if (existing) {
        if (DEV_ACCOUNT_DOMAIN.test(existing.email)) {
          throw new UatProvisionError('DEV_SEED_REFUSED', { field: `${role}.dcUserId` });
        }
        if (
          existing.tenantId !== tenantId ||
          existing.email !== account.email ||
          existing.displayName !== account.displayName ||
          existing.teamId !== ownerTeam.id ||
          existing.role !== 'AGENT' ||
          existing.passwordHash !== KEYCLOAK_MANAGED_PASSWORD ||
          !existing.isActive
        ) {
          throw new UatProvisionError('USER_CONFLICT', { part });
        }
        results.push({ part, status: 'UNCHANGED', userId: account.dcUserId });
        continue;
      }
      const sameEmail = await tx.user.findUnique({
        where: { tenantId_email: { tenantId, email: account.email } },
        select: { id: true },
      });
      if (sameEmail) throw new UatProvisionError('USER_CONFLICT', { part, field: 'email' });
      if (write) {
        await create(
          () =>
            tx.user.create({
              data: {
                id: account.dcUserId,
                tenantId,
                email: account.email,
                displayName: account.displayName,
                passwordHash: KEYCLOAK_MANAGED_PASSWORD,
                role: 'AGENT',
                teamId: ownerTeam.id,
              },
            }),
          'USER_CONFLICT',
          { part },
        );
      }
      results.push({ part, status: created, userId: account.dcUserId });
    }

    // 3a) authoring subject: STANDARD, ไม่มี direct review authority, ไม่ใช่ service principal
    for (const [role, account] of accounts) {
      const part = `subject:${role}`;
      const subjectId = account.dcUserId;
      const existing = await tx.iamAuthoringSubject.findUnique({
        where: { tenantId_subjectId: { tenantId, subjectId } },
      });
      if (existing) {
        if (
          existing.authenticationStrength !== 'STANDARD' ||
          existing.directReviewAuthority ||
          existing.isServicePrincipal
        ) {
          throw new UatProvisionError('SUBJECT_CONFLICT', { part });
        }
        results.push({ part, status: 'UNCHANGED', subjectId });
        continue;
      }
      if (write) {
        await create(
          () =>
            tx.iamAuthoringSubject.create({
              data: { tenantId, subjectId, authenticationStrength: 'STANDARD' },
            }),
          'SUBJECT_CONFLICT',
          { part },
        );
      }
      results.push({ part, status: created, subjectId });
    }

    // 3b) TEAM grant ของ owner team: ชุดของ subject ใน tenant ต้องว่าง (สร้าง) หรือเท่ากับที่คาดทุกตัว
    for (const [role, account, capabilities] of accounts) {
      const part = `grants:${role}`;
      const subjectId = account.dcUserId;
      const existing = await tx.iamAuthoringCapabilityGrant.findMany({
        where: { tenantId, subjectId },
      });
      if (existing.length > 0) {
        const exact =
          existing.length === capabilities.length &&
          existing.every(
            (grant) =>
              grant.scopeKind === 'TEAM' &&
              grant.scopeId === ownerTeam.id &&
              grant.expiresAt === null &&
              (capabilities as readonly string[]).includes(grant.capability),
          ) &&
          new Set(existing.map((grant) => grant.capability)).size === capabilities.length;
        if (!exact) throw new UatProvisionError('GRANTS_CONFLICT', { part });
        results.push({ part, status: 'UNCHANGED', subjectId, teamId: ownerTeam.id });
        continue;
      }
      if (write) {
        await create(
          () =>
            tx.iamAuthoringCapabilityGrant.createMany({
              data: capabilities.map((capability) => ({
                tenantId,
                subjectId,
                capability,
                scopeKind: 'TEAM',
                scopeId: ownerTeam.id,
                grantedByRef: PROVISIONED_BY_REF,
              })),
            }),
          'GRANTS_CONFLICT',
          { part },
        );
      }
      results.push({ part, status: created, subjectId, teamId: ownerTeam.id });
    }

    return results;
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────

const LINE_TYPE = 'u1.uat.provision';

function parseArguments(argv: readonly string[]): { input: string; mode: UatProvisionMode } {
  let input: string | undefined;
  let mode: UatProvisionMode = 'apply';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') mode = 'check';
    else if (argument === '--input' && argv[index + 1] && !input) input = argv[(index += 1)];
    else throw new UatProvisionError('USAGE');
  }
  if (!input) throw new UatProvisionError('USAGE');
  return { input, mode };
}

/** error → field ที่ปลอดภัย (รหัส/ชื่อ field/ชนิด) — ไม่มี message ดิบของ Prisma/pg ที่อาจมี host/ค่า */
function failure(error: unknown): Record<string, string> {
  if (error instanceof UatProvisionError) return { code: error.code, ...error.safeParams };
  if (error instanceof UatRunError) {
    return {
      code: error.code,
      ...Object.fromEntries(
        Object.entries(error.safeParams ?? {}).map(([key, value]) => [key, String(value)]),
      ),
    };
  }
  return { code: 'UNEXPECTED', error: error instanceof Error ? error.name : 'unknown' };
}

/**
 * `node dist/uat-provision-main.js --input <file|-> [--check]` — คืน exit code; `write` รับทีละบรรทัด JSON
 * อ่าน `DATABASE_URL` (owner/operator) และ `UAT_TENANT_ID`/`UAT_TENANT_SLUG` (ถ้ามี) จาก environment
 */
export async function runUatProvisionCli(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  write: (line: string) => void,
): Promise<number> {
  const emit = (record: Record<string, string>) =>
    write(JSON.stringify({ type: LINE_TYPE, ...record }));
  let mode: UatProvisionMode = 'apply';
  let database: PrismaClient | null = null;
  try {
    const parsed = parseArguments(argv);
    mode = parsed.mode;
    // `--input -` = อ่านจาก stdin (uat-deploy.sh ส่งไฟล์ทาง stdin — ไฟล์ไม่เข้าไปอยู่ใน container)
    const fromStdin = parsed.input === '-';
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(fromStdin ? 0 : parsed.input, 'utf8'));
    } catch {
      throw new UatProvisionError('INPUT_UNREADABLE', { field: 'input' });
    }
    const input = parseUatProvisionInput(raw, {
      baseDirectory: fromStdin ? process.cwd() : dirname(resolve(parsed.input)),
      environment,
    });
    const url = environment.DATABASE_URL;
    if (!url) throw new UatProvisionError('DATABASE_URL_MISSING');
    database = new PrismaClient({ datasources: { db: { url } } });
    const results = await new UatProvisioner(database).run(input, mode);
    for (const result of results) emit({ mode, ...result });
    emit({ mode, status: 'PASS' });
    return 0;
  } catch (error) {
    emit({ mode, status: 'FAIL', ...failure(error) });
    return 1;
  } finally {
    await database?.$disconnect();
  }
}

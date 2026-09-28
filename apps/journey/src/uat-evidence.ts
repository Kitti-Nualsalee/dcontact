/**
 * Owner: UAT control — หลักฐานภาพหน้าจอ, negative scan และ evidence bundle ของ UAT run (U1.5 #433)
 *
 * Authority: Phase Contract #374, evidence/defect #379
 *
 * - ภาพหน้าจอเก็บใน object storage ส่วนตัวภายใน UAT stack ผ่าน `UatEvidenceStorage` เท่านั้น อัปโหลดและอ่าน
 *   ผ่าน API ที่ตรวจสิทธิ์ฝั่ง server ทุกครั้ง — ไม่มี public URL/presigned URL; DB เก็บแค่ metadata + sha256
 * - หลักฐานของ run ที่ปิดแล้วแก้/เพิ่มไม่ได้ (append-only + trigger เหมือน `uat_run_step_results`)
 * - negative scan ตรวจผลบันทึกทุก step และ metadata ของภาพทุกไฟล์; พบอะไร = finding S1 และ run ถือว่า `FAIL`
 *   ผล scan บันทึกแบบ append-only ต่อ input digest (เนื้อหาเดิม = ผลเดิม ไม่ scan ซ้ำแม้ภาพหมดอายุ retention แล้ว)
 * - bundle เป็น JSON metadata ล้วน (ไม่มี byte ของภาพ ไม่มีข้อความที่ scan เจอ) พร้อม digest ของตัวเอง
 */
import { createHash, randomUUID } from 'node:crypto';
import { withTenantDatabaseTransaction, type Prisma, type PrismaClient } from '@d-contact/db';
import { journeyAuthoringDigest } from './journey-authoring-canonical.js';
import type { JourneyAuthoringActor } from './journey-authoring-model.js';
import type { JourneyCommandContext } from './journey-authoring-repository.js';
import {
  UAT_EVIDENCE_CONTENT_TYPES,
  UAT_EVIDENCE_MAX_BYTES,
  UatEvidenceFormatError,
  extractUatImageText,
  scanUatText,
  sniffUatEvidence,
  type UatEvidenceContentType,
  type UatImageTextField,
  type UatSensitiveKind,
} from './uat-evidence-content.js';
import {
  UAT_STATE_LABELS,
  UAT_STEP_ID_PATTERN,
  UatRunError,
  type UatFixturePackManifestV1,
  type UatStateLabelV1,
  type UatStepResultView,
} from './uat-run.js';

type Tx = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

/** version ของกติกา scan — เปลี่ยนกติกาแล้วต้องเปลี่ยนค่านี้ เพื่อให้ scan ใหม่ไม่ถูกแทนด้วยผลเก่า */
export const UAT_NEGATIVE_SCAN_VERSION = 'UAT_NEGATIVE_SCAN_V1';

// ── Storage port ──────────────────────────────────────────────────────────

/**
 * object storage ส่วนตัวของหลักฐาน UAT — adapter ต้องไม่มีทางสร้าง public/presigned URL
 * key = `uat-evidence/<tenantId>/<runId>/<evidenceId>`
 */
export interface UatEvidenceStorage {
  putObject(input: {
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly contentType: UatEvidenceContentType;
    readonly sha256: string;
  }): Promise<void>;
  /** `null` = ไม่มี object แล้ว (เช่นหมดอายุ retention) */
  getObject(key: string): Promise<Uint8Array | null>;
  deleteObject(key: string): Promise<void>;
}

export const UAT_EVIDENCE_KEY_PREFIX = 'uat-evidence/';

export function uatEvidenceStorageKey(tenantId: string, runId: string, evidenceId: string): string {
  return `${UAT_EVIDENCE_KEY_PREFIX}${tenantId}/${runId}/${evidenceId}`;
}

// ── Views ─────────────────────────────────────────────────────────────────

export interface UatEvidenceView {
  evidenceId: string;
  stepId: string;
  sha256: string;
  sizeBytes: number;
  contentType: UatEvidenceContentType;
  recordedByRef: string;
  recordedAt: string;
}

export type UatScanFindingLocation =
  | {
      source: 'STEP_RESULT';
      stepId: string;
      /** ลำดับของผลใน run (เรียงตามเวลาที่บันทึก) */
      resultIndex: number;
      field: 'actual' | 'expected' | 'correlationId';
    }
  | {
      source: 'EVIDENCE';
      stepId: string;
      evidenceId: string;
      field: UatImageTextField | 'CONTENT';
    };

export type UatScanFindingKind =
  UatSensitiveKind | 'EVIDENCE_UNAVAILABLE' | 'EVIDENCE_INTEGRITY' | 'EVIDENCE_FORMAT';

/** finding บอกได้แค่ชนิด + ตำแหน่ง ไม่มีข้อความที่ match */
export interface UatScanFinding {
  kind: UatScanFindingKind;
  severity: 'S1';
  location: UatScanFindingLocation;
}

export interface UatRunScanView {
  scanId: string;
  runId: string;
  scannerVersion: string;
  inputDigest: string;
  status: 'PASSED' | 'FAILED';
  severity: 'S1' | null;
  findings: UatScanFinding[];
  scannedByRef: string;
  scannedAt: string;
}

export interface UatEvidenceBundleV1 {
  schema: 'UatEvidenceBundleV1';
  manifest: {
    runId: string;
    sequence: number;
    environment: string;
    packVersion: string;
    fixtureDigest: string;
    buildSha: string;
    journeyId: string | null;
    lifecycle: 'ACTIVE' | 'COMPLETED' | 'ABANDONED';
    openedAt: string;
    closedAt: string | null;
  };
  /** step catalog พร้อมป้าย state ต่อ step — REAL_STATE กับ SIMULATION_ONLY ไม่ปนกัน */
  steps: Array<{ stepId: string; title: string; stateLabel: UatStateLabelV1 }>;
  stateLabels: Record<UatStateLabelV1, string[]>;
  stepResults: UatStepResultView[];
  screenshots: UatEvidenceView[];
  /** audit ของ Journey ของ run — metadata/ref เท่านั้น (ไม่รวมการอ่าน audit เอง) */
  auditRefs: Array<{
    auditId: string;
    action: string;
    reasonCode: string;
    beforeDigest: string | null;
    afterDigest: string | null;
    occurredAt: string;
  }>;
  scan: UatRunScanView;
  /** FAIL = scan พบ finding หรือผลล่าสุดของ step ใด FAIL; INCOMPLETE = ยังมี step ที่ไม่ผ่าน/ไม่มีผล */
  verdict: 'PASS' | 'FAIL' | 'INCOMPLETE';
  /** sha256 ของ canonical JSON ของ bundle ทั้งก้อนโดยไม่รวม field `digest` */
  digest: string;
}

export interface RecordUatEvidenceInput {
  readonly runId: string;
  readonly stepId: string;
  /** content type ที่ client ประกาศ — ต้องตรงกับ magic bytes */
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

// ── Pure helpers ──────────────────────────────────────────────────────────

/**
 * ตรวจไฟล์ก่อนเก็บ: ต้องเป็น PNG/JPEG ตาม magic bytes และตรงกับ content type ที่ประกาศ
 * trace (zip), HAR/JSON, network log (ข้อความ) และอื่น ๆ ถูกปฏิเสธ
 */
export function assertUatScreenshot(
  contentType: string,
  bytes: Uint8Array,
): UatEvidenceContentType {
  if (bytes.byteLength > UAT_EVIDENCE_MAX_BYTES) {
    throw new UatRunError('EVIDENCE_TOO_LARGE', { maxBytes: UAT_EVIDENCE_MAX_BYTES });
  }
  const detected = sniffUatEvidence(bytes);
  if (bytes.byteLength === 0 || (detected !== 'PNG' && detected !== 'JPEG')) {
    throw new UatRunError('EVIDENCE_TYPE_REJECTED', { detected });
  }
  const declared = (UAT_EVIDENCE_CONTENT_TYPES as readonly string[]).includes(contentType)
    ? (contentType as UatEvidenceContentType)
    : null;
  const actual: UatEvidenceContentType = detected === 'PNG' ? 'image/png' : 'image/jpeg';
  if (declared !== actual) {
    throw new UatRunError('EVIDENCE_TYPE_REJECTED', { detected, reason: 'CONTENT_TYPE_MISMATCH' });
  }
  try {
    extractUatImageText(bytes, actual);
  } catch (error) {
    if (error instanceof UatEvidenceFormatError) {
      throw new UatRunError('EVIDENCE_TYPE_REJECTED', { detected, reason: error.reason });
    }
    throw error;
  }
  return actual;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** digest ของ bundle — canonical JSON เดียวกับ digest ของ fixture pack (J5 canonical) */
export function uatEvidenceBundleDigest(bundle: Omit<UatEvidenceBundleV1, 'digest'>): string {
  return journeyAuthoringDigest(bundle);
}

/** คำนวณ digest ใหม่จากเนื้อหาแล้วเทียบกับ digest ที่ bundle อ้าง */
export function verifyUatEvidenceBundleDigest(bundle: UatEvidenceBundleV1): boolean {
  const { digest, ...content } = bundle;
  return SHA256.test(digest) && uatEvidenceBundleDigest(content) === digest;
}

function sensitiveFindings(
  text: string | null,
  location: UatScanFindingLocation,
): UatScanFinding[] {
  if (!text) return [];
  return scanUatText(text).map((kind) => ({ kind, severity: 'S1', location }));
}

/** negative scan ของผลบันทึก step — pure */
export function scanUatStepResults(results: readonly UatStepResultView[]): UatScanFinding[] {
  return results.flatMap((result, resultIndex) =>
    (['actual', 'expected', 'correlationId'] as const).flatMap((field) =>
      sensitiveFindings(result[field], {
        source: 'STEP_RESULT',
        stepId: result.stepId,
        resultIndex,
        field,
      }),
    ),
  );
}

/** negative scan ของภาพหนึ่งไฟล์: integrity (sha256) + metadata ที่เป็นข้อความ — pure */
export function scanUatEvidenceBytes(
  evidence: Pick<UatEvidenceView, 'evidenceId' | 'stepId' | 'sha256' | 'contentType'>,
  bytes: Uint8Array | null,
): UatScanFinding[] {
  const at = (field: UatImageTextField | 'CONTENT'): UatScanFindingLocation => ({
    source: 'EVIDENCE',
    stepId: evidence.stepId,
    evidenceId: evidence.evidenceId,
    field,
  });
  if (!bytes) return [{ kind: 'EVIDENCE_UNAVAILABLE', severity: 'S1', location: at('CONTENT') }];
  if (sha256Hex(bytes) !== evidence.sha256) {
    return [{ kind: 'EVIDENCE_INTEGRITY', severity: 'S1', location: at('CONTENT') }];
  }
  let texts;
  try {
    texts = extractUatImageText(bytes, evidence.contentType);
  } catch {
    return [{ kind: 'EVIDENCE_FORMAT', severity: 'S1', location: at('CONTENT') }];
  }
  const found = new Map<string, UatScanFinding>();
  for (const { field, text } of texts) {
    for (const finding of sensitiveFindings(text, at(field))) {
      found.set(`${finding.kind}:${field}`, finding);
    }
  }
  return [...found.values()];
}

function verdictOf(
  steps: readonly { stepId: string }[],
  results: readonly UatStepResultView[],
  scan: UatRunScanView,
): UatEvidenceBundleV1['verdict'] {
  if (scan.status === 'FAILED') return 'FAIL';
  const latest = new Map<string, UatStepResultView['outcome']>();
  for (const result of results) latest.set(result.stepId, result.outcome);
  if ([...latest.values()].includes('FAIL')) return 'FAIL';
  return steps.every((step) => latest.get(step.stepId) === 'PASS') ? 'PASS' : 'INCOMPLETE';
}

// ── Repository ────────────────────────────────────────────────────────────

type RunRow = Awaited<ReturnType<Tx['uatRun']['findFirstOrThrow']>>;
type PackRow = Awaited<ReturnType<Tx['uatFixturePack']['findFirstOrThrow']>>;
type EvidenceRow = Awaited<ReturnType<Tx['uatRunEvidence']['findFirstOrThrow']>>;
type ScanRow = Awaited<ReturnType<Tx['uatRunScan']['findFirstOrThrow']>>;

interface RunSnapshot {
  run: RunRow;
  pack: PackRow;
  manifest: UatFixturePackManifestV1;
  results: UatStepResultView[];
  evidence: EvidenceRow[];
}

function evidenceView(row: EvidenceRow): UatEvidenceView {
  return {
    evidenceId: row.id,
    stepId: row.stepId,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    contentType: row.contentType as UatEvidenceContentType,
    recordedByRef: row.recordedByRef,
    recordedAt: row.recordedAt.toISOString(),
  };
}

function scanView(row: ScanRow): UatRunScanView {
  return {
    scanId: row.id,
    runId: row.runId,
    scannerVersion: row.scannerVersion,
    inputDigest: row.inputDigest,
    status: row.status,
    severity: row.severity === 'S1' ? 'S1' : null,
    findings: row.findings as unknown as UatScanFinding[],
    scannedByRef: row.scannedByRef,
    scannedAt: row.scannedAt.toISOString(),
  };
}

/** trigger ของ DB ปฏิเสธ insert เพราะ run ปิดไปแล้วระหว่างทาง */
function runClosedByTrigger(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UAT_RUN_CLOSED');
}

function uniqueViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002';
}

export class UatEvidenceRepository {
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    private readonly storage: UatEvidenceStorage,
    options: { now?: () => Date; id?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  private scoped<T>(tenantId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenantDatabaseTransaction(this.database, tenantId, work);
  }

  // ── Commands ──

  /**
   * อัปโหลดภาพหน้าจอของ step หนึ่ง — idempotent ต่อ `Idempotency-Key`
   * 1. ตรวจไฟล์ (ชนิด/ขนาด/โครงสร้าง) และสิทธิ์/สถานะ run ก่อนแตะ storage
   * 2. เขียน object ลง storage ส่วนตัว
   * 3. transaction: insert metadata + receipt (trigger ปฏิเสธถ้า run ปิดไประหว่างทาง → ลบ object ทิ้ง)
   */
  async record(
    context: JourneyCommandContext,
    input: RecordUatEvidenceInput,
  ): Promise<UatEvidenceView> {
    if (!UAT_STEP_ID_PATTERN.test(input.stepId)) {
      throw new UatRunError('VALIDATION_FAILED', { field: 'stepId' });
    }
    const contentType = assertUatScreenshot(input.contentType, input.bytes);
    const sha256 = sha256Hex(input.bytes);
    const requestHash = journeyAuthoringDigest({
      command: 'RecordUatEvidence',
      actor: context.actor.subjectId,
      input: {
        runId: input.runId,
        stepId: input.stepId,
        contentType,
        sha256,
        sizeBytes: input.bytes.byteLength,
      },
    });

    const checked = await this.scoped(context.tenantId, async (tx) => {
      const replay = await this.replay(tx, context, requestHash);
      if (replay) return { replay: replay as unknown as UatEvidenceView, run: null };
      const { run, manifest } = await this.participantRun(tx, context, input.runId);
      if (run.lifecycle !== 'ACTIVE') throw new UatRunError('UAT_RUN_CLOSED');
      if (!manifest.steps.some((step) => step.stepId === input.stepId)) {
        throw new UatRunError('VALIDATION_FAILED', { field: 'stepId' });
      }
      return { replay: null, run };
    });
    if (!checked.run) return checked.replay!;

    const evidenceId = this.id();
    const key = uatEvidenceStorageKey(context.tenantId, checked.run.id, evidenceId);
    await this.storage.putObject({ key, bytes: input.bytes, contentType, sha256 });
    try {
      return await this.scoped(context.tenantId, async (tx) => {
        // คำขอซ้ำที่วิ่งขนานกันจบไปก่อน — ใช้ผลนั้น แล้วลบ object ของคำขอนี้ทิ้ง
        const replay = await this.replay(tx, context, requestHash);
        if (replay) return replay as unknown as UatEvidenceView;
        const recordedAt = this.now();
        const row = await tx.uatRunEvidence.create({
          data: {
            id: evidenceId,
            tenantId: context.tenantId,
            runId: checked.run.id,
            stepId: input.stepId,
            contentType,
            sizeBytes: input.bytes.byteLength,
            sha256,
            storageKey: key,
            recordedByRef: context.actor.subjectId,
            recordedAt,
          },
        });
        const view = evidenceView(row);
        await tx.uatCommandReceipt.create({
          data: {
            id: this.id(),
            tenantId: context.tenantId,
            idempotencyKey: context.idempotencyKey,
            commandName: 'RecordUatEvidence',
            requestHash,
            runId: checked.run.id,
            response: view as unknown as Prisma.InputJsonValue,
            completedAt: this.now(),
          },
        });
        return view;
      }).then(async (view) => {
        if (view.evidenceId !== evidenceId) await this.discard(key);
        return view;
      });
    } catch (error) {
      await this.discard(key);
      if (runClosedByTrigger(error)) throw new UatRunError('UAT_RUN_CLOSED');
      if (uniqueViolation(error)) {
        // key เดียวกันถูกใช้พร้อมกัน: คำขอเดียวกัน = replay ผลที่บันทึกไปก่อน, ต่างกัน = conflict
        const replay = await this.scoped(context.tenantId, (tx) =>
          this.replay(tx, context, requestHash),
        );
        if (replay) return replay as unknown as UatEvidenceView;
        throw new UatRunError('IDEMPOTENCY_CONFLICT');
      }
      throw error;
    }
  }

  /**
   * negative scan ของ run — ผลของ input เดิม (ผลบันทึก + หลักฐานชุดเดิม + กติกาเดิม) ถูกใช้ซ้ำ
   * ไม่ต้องใช้ `Idempotency-Key`: คำสั่งนี้ idempotent โดยธรรมชาติ (unique ต่อ input digest)
   * run ที่ปิดแล้วยัง scan ได้ เพราะ scan ไม่เปลี่ยนหลักฐาน — เป็นผลตรวจที่ต่อท้ายแบบ append-only
   */
  async scan(
    tenantId: string,
    actor: JourneyAuthoringActor,
    runId: string,
  ): Promise<UatRunScanView> {
    const snapshot = await this.scoped(tenantId, (tx) =>
      this.snapshot(tx, { tenantId, actor }, runId),
    );
    return this.scanSnapshot(tenantId, actor, snapshot);
  }

  // ── Reads ──

  async list(
    tenantId: string,
    actor: JourneyAuthoringActor,
    runId: string,
  ): Promise<{ runId: string; items: UatEvidenceView[] }> {
    return this.scoped(tenantId, async (tx) => {
      const { run } = await this.participantRun(tx, { tenantId, actor }, runId);
      const rows = await this.evidenceRows(tx, run);
      return { runId: run.id, items: rows.map(evidenceView) };
    });
  }

  /** byte ของภาพ — ตรวจ sha256 กับที่บันทึกไว้ก่อนส่งออก (object ถูกแก้ = ไม่ส่ง) */
  async content(
    tenantId: string,
    actor: JourneyAuthoringActor,
    runId: string,
    evidenceId: string,
  ): Promise<{ contentType: UatEvidenceContentType; sha256: string; bytes: Uint8Array }> {
    const row = await this.scoped(tenantId, async (tx) => {
      const { run } = await this.participantRun(tx, { tenantId, actor }, runId);
      const found = UUID.test(evidenceId)
        ? await tx.uatRunEvidence.findUnique({
            where: { tenantId_id: { tenantId, id: evidenceId } },
          })
        : null;
      if (!found || found.runId !== run.id) throw new UatRunError('EVIDENCE_NOT_FOUND');
      return found;
    });
    const bytes = await this.storage.getObject(row.storageKey);
    if (!bytes) throw new UatRunError('EVIDENCE_NOT_FOUND', { reason: 'RETENTION_EXPIRED' });
    if (sha256Hex(bytes) !== row.sha256) throw new UatRunError('EVIDENCE_INTEGRITY_FAILED');
    return { contentType: row.contentType as UatEvidenceContentType, sha256: row.sha256, bytes };
  }

  /** evidence bundle (JSON) ของ run — scan ให้เป็นปัจจุบันก่อนเสมอ */
  async bundle(
    tenantId: string,
    actor: JourneyAuthoringActor,
    runId: string,
  ): Promise<UatEvidenceBundleV1> {
    const { snapshot, auditRefs } = await this.scoped(tenantId, async (tx) => {
      const snapshot = await this.snapshot(tx, { tenantId, actor }, runId);
      const audit = snapshot.run.journeyId
        ? await tx.jrAuthoringAudit.findMany({
            where: {
              tenantId,
              resourceKind: 'JOURNEY',
              resourceId: snapshot.run.journeyId,
              // การอ่าน audit เป็น access log ไม่ใช่หลักฐานของ run — ไม่ให้ bundle เปลี่ยนเพราะมีคนอ่าน
              action: { not: 'AUDIT_READ' },
            },
            orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              action: true,
              reasonCode: true,
              beforeDigest: true,
              afterDigest: true,
              occurredAt: true,
            },
          })
        : [];
      return {
        snapshot,
        auditRefs: audit.map((row) => ({
          auditId: row.id,
          action: row.action,
          reasonCode: row.reasonCode,
          beforeDigest: row.beforeDigest,
          afterDigest: row.afterDigest,
          occurredAt: row.occurredAt.toISOString(),
        })),
      };
    });
    const scan = await this.scanSnapshot(tenantId, actor, snapshot);
    const { run, pack, manifest, results, evidence } = snapshot;
    const steps = manifest.steps.map(({ stepId, title, stateLabel }) => ({
      stepId,
      title,
      stateLabel,
    }));
    const stateLabels = Object.fromEntries(
      UAT_STATE_LABELS.map((label) => [
        label,
        steps.filter((step) => step.stateLabel === label).map((step) => step.stepId),
      ]),
    ) as Record<UatStateLabelV1, string[]>;
    const content: Omit<UatEvidenceBundleV1, 'digest'> = {
      schema: 'UatEvidenceBundleV1',
      manifest: {
        runId: run.id,
        sequence: run.sequence,
        environment: pack.environment,
        packVersion: pack.packVersion,
        fixtureDigest: pack.digest,
        buildSha: pack.buildSha,
        journeyId: run.journeyId,
        lifecycle: run.lifecycle,
        openedAt: run.openedAt.toISOString(),
        closedAt: run.closedAt?.toISOString() ?? null,
      },
      steps,
      stateLabels,
      stepResults: results,
      screenshots: evidence.map(evidenceView),
      auditRefs,
      scan,
      verdict: verdictOf(steps, results, scan),
    };
    return { ...content, digest: uatEvidenceBundleDigest(content) };
  }

  // ── Internals ──

  private async scanSnapshot(
    tenantId: string,
    actor: JourneyAuthoringActor,
    snapshot: RunSnapshot,
  ): Promise<UatRunScanView> {
    const { run, results, evidence } = snapshot;
    const inputDigest = journeyAuthoringDigest({
      scannerVersion: UAT_NEGATIVE_SCAN_VERSION,
      runId: run.id,
      results,
      evidence: evidence.map(evidenceView),
    });
    const existing = () =>
      this.scoped(tenantId, (tx) =>
        tx.uatRunScan.findUnique({
          where: { tenantId_runId_inputDigest: { tenantId, runId: run.id, inputDigest } },
        }),
      );
    const found = await existing();
    if (found) return scanView(found);

    const findings = scanUatStepResults(results);
    for (const row of evidence) {
      const bytes = await this.storage.getObject(row.storageKey);
      findings.push(...scanUatEvidenceBytes(evidenceView(row), bytes));
    }
    const failed = findings.length > 0;
    try {
      const row = await this.scoped(tenantId, (tx) =>
        tx.uatRunScan.create({
          data: {
            id: this.id(),
            tenantId,
            runId: run.id,
            scannerVersion: UAT_NEGATIVE_SCAN_VERSION,
            inputDigest,
            status: failed ? 'FAILED' : 'PASSED',
            severity: failed ? 'S1' : null,
            findings: findings as unknown as Prisma.InputJsonValue,
            scannedByRef: actor.subjectId,
            scannedAt: this.now(),
          },
        }),
      );
      return scanView(row);
    } catch (error) {
      // scan ของ input เดียวกันที่วิ่งขนานกันบันทึกไปก่อน — ผลต้องเหมือนกันจึงใช้แถวนั้น
      if (uniqueViolation(error)) {
        const raced = await existing();
        if (raced) return scanView(raced);
      }
      throw error;
    }
  }

  private async snapshot(
    tx: Tx,
    context: { tenantId: string; actor: JourneyAuthoringActor },
    runId: string,
  ): Promise<RunSnapshot> {
    const { run, pack, manifest } = await this.participantRun(tx, context, runId);
    const rows = await tx.uatRunStepResult.findMany({
      where: { tenantId: run.tenantId, runId: run.id },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
    });
    return {
      run,
      pack,
      manifest,
      results: rows.map((result) => ({
        stepId: result.stepId,
        outcome: result.outcome,
        expected: result.expected,
        actual: result.actual,
        severity: result.severity,
        correlationId: result.correlationId,
        stateLabel: result.stateLabel,
        recordedByRef: result.recordedByRef,
        recordedAt: result.recordedAt.toISOString(),
      })),
      evidence: await this.evidenceRows(tx, run),
    };
  }

  private evidenceRows(tx: Tx, run: RunRow): Promise<EvidenceRow[]> {
    return tx.uatRunEvidence.findMany({
      where: { tenantId: run.tenantId, runId: run.id },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** run ของ tenant ใน token + ผู้เรียกเป็นผู้ทดสอบของ pack; ไม่ใช่ = ตอบเหมือนไม่มี run (ไม่เผย existence) */
  private async participantRun(
    tx: Tx,
    context: { tenantId: string; actor: JourneyAuthoringActor },
    runId: string,
  ): Promise<{ run: RunRow; pack: PackRow; manifest: UatFixturePackManifestV1 }> {
    const run = UUID.test(runId)
      ? await tx.uatRun.findUnique({
          where: { tenantId_id: { tenantId: context.tenantId, id: runId } },
        })
      : null;
    if (!run) throw new UatRunError('UAT_RUN_NOT_FOUND');
    const pack = await tx.uatFixturePack.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: run.tenantId, id: run.fixturePackId } },
    });
    const manifest = pack.manifest as unknown as UatFixturePackManifestV1;
    if (![manifest.makerSubjectId, manifest.reviewerSubjectId].includes(context.actor.subjectId)) {
      throw new UatRunError('UAT_RUN_NOT_FOUND');
    }
    return { run, pack, manifest };
  }

  private async replay(tx: Tx, context: JourneyCommandContext, requestHash: string) {
    const receipt = await tx.uatCommandReceipt.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId: context.tenantId,
          idempotencyKey: context.idempotencyKey,
        },
      },
    });
    if (!receipt) return null;
    if (receipt.requestHash !== requestHash) throw new UatRunError('IDEMPOTENCY_CONFLICT');
    return receipt.response;
  }

  /** ลบ object ที่ไม่มี metadata อ้างถึง — ล้มก็ไม่เป็นไร (retention 90 วันเก็บกวาดให้) */
  private async discard(key: string): Promise<void> {
    await this.storage.deleteObject(key).catch(() => undefined);
  }
}

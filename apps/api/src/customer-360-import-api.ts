import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { Controller, Inject, Post, Req, Res, UseFilters } from '@nestjs/common';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  C360ImportCsvError,
  C360ImportMappingError,
  C360ImportPreviewError,
  C360ProfileCommandError,
  authorizeC360ContactAccess,
  authorizeC360ContactCreate,
  c360Uuid,
  createC360ImportDuplicateAuthority,
  createC360Profile,
  executeC360ProfileCommand,
  normalizeC360ImportRow,
  prepareC360ImportPreview,
  validateC360ImportMapping,
  C360_PROFILE_WRITE_VERSION,
  type C360CommandAuthorization,
  type C360ProfileCommandResult,
  type C360VerifiedActor,
} from '@d-contact/customer-360';
import {
  C360ImportIntakeError,
  readC360ImportMultipart,
  type C360ImportMultipart,
} from './customer-360-import-multipart.js';
import {
  CUSTOMER_360_DATABASE,
  Customer360Errors,
  Customer360HttpError,
  c360CurrentActor,
  commandActor,
  requestIdentity,
  type C360RequestIdentity,
} from './customer-360-api.js';
import { CUSTOMER_360_WRITE_RUNTIME, type C360WriteRuntime } from './customer-360-write-runtime.js';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import {
  C360_IMPORT_POLICY,
  CUSTOMER_360_SEARCH_LIMITER,
  type SharedRateLimiter,
} from './shared-rate-limiter.js';

/** เวลารวมของ confirm; เกินแล้วแถวที่เหลือคืน NOT_ATTEMPTED และส่งซ้ำด้วย commandId เดิมได้ */
export const C360_IMPORT_CONFIRM_BUDGET_MS = 45_000;

type PreviewResult = Awaited<ReturnType<typeof prepareC360ImportPreview>>;

export type C360ImportRowState =
  'APPLIED' | 'REJECTED' | 'PENDING' | 'UNKNOWN' | 'NOT_SELECTED' | 'NOT_ATTEMPTED';

export interface C360ImportRowResult {
  rowNo: number;
  state: C360ImportRowState;
  code?: string;
  contactId?: string;
  fieldErrors?: readonly { field: string; code: string }[];
}

/** child commandId คงที่จาก (request commandId, plan, rowNo) เพื่อให้ส่งซ้ำไม่สร้างลูกค้าซ้ำ */
export function c360ImportChildCommandId(
  commandId: string,
  planHash: string,
  rowNo: number,
): string {
  const hash = createHash('sha256')
    .update(`c360-import-row-v1:${commandId}:${planHash}:${rowNo}`)
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** แปลงผลของ command เป็นสถานะรายแถวที่ไม่มีค่า raw */
export function c360ImportRowResult(
  rowNo: number,
  result: C360ProfileCommandResult,
): C360ImportRowResult {
  if (result.state === 'PENDING') return { rowNo, state: 'PENDING' };
  if (result.state === 'UNKNOWN') return { rowNo, state: 'UNKNOWN' };
  const { receipt } = result;
  if (receipt.outcome === 'REJECTED')
    return { rowNo, state: 'REJECTED', code: receipt.code ?? 'REJECTED' };
  const contact = receipt.resourceRefs.find((ref) => ref.type === 'CONTACT');
  return { rowNo, state: 'APPLIED', ...(contact ? { contactId: contact.id } : {}) };
}

function intakeError(error: unknown): never {
  if (error instanceof C360ImportIntakeError)
    throw new Customer360HttpError(error.status, error.code, error.status === 503);
  throw error;
}

function importError(error: unknown): never {
  if (error instanceof C360ImportCsvError)
    throw new Customer360HttpError(error.code === 'CSV_INVALID' ? 400 : 413, error.code);
  if (error instanceof C360ImportMappingError) throw new Customer360HttpError(400, error.code);
  if (error instanceof C360ImportPreviewError)
    throw new Customer360HttpError(
      error.code === 'PREVIEW_STALE' ? 409 : 503,
      error.code,
      error.code !== 'PREVIEW_STALE',
    );
  throw error;
}

@UseFilters(Customer360Errors)
@Controller('api/v1/customer-360/imports')
@GatewayRoles('admin')
export class Customer360ImportController {
  constructor(
    @Inject(CUSTOMER_360_DATABASE) private readonly db: PrismaClient,
    @Inject(CUSTOMER_360_SEARCH_LIMITER) private readonly limiter: SharedRateLimiter,
    @Inject(CUSTOMER_360_WRITE_RUNTIME) private readonly runtime: C360WriteRuntime,
  ) {}

  /** Preview ไม่สร้าง Contact/grant/audit; ผลมี cell ของไฟล์ที่ Admin ส่งมาเองเท่านั้น */
  @Post('preview')
  async preview(
    @Req() req: AuthenticatedGatewayRequest,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const identity = requestIdentity(req);
    this.ensureWriteRuntime();
    await this.consume(identity);
    const input = await this.read(req);
    const result = await this.prepare(identity, input);
    this.json(response, 200, {
      rulesVersion: result.preview.rulesVersion,
      planHash: result.preview.planHash,
      headers: result.preview.headers,
      counts: result.preview.counts,
      rows: result.preview.rows,
    });
  }

  /** ส่งไฟล์เดิมซ้ำ: ตรวจ planHash แล้วสร้างทีละแถวด้วย create command เดิมของ C4 */
  @Post('confirm')
  async confirm(
    @Req() req: AuthenticatedGatewayRequest,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const startedAt = Date.now();
    const identity = requestIdentity(req);
    this.ensureWriteRuntime();
    await this.consume(identity);
    const input = await this.read(req);
    let commandId: string;
    try {
      commandId = c360Uuid(input.fields.commandId);
    } catch {
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    }
    if (!/^[0-9a-f]{64}$/.test(input.fields.planHash ?? ''))
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    const { preview, mapping } = await this.prepare(identity, input);
    if (preview.planHash !== input.fields.planHash)
      throw new Customer360HttpError(409, 'PREVIEW_STALE');
    if (preview.counts.valid < 1) throw new Customer360HttpError(409, 'NO_VALID_ROWS');

    const actor = commandActor(identity);
    const csvRows = preview.rows;
    const rows: C360ImportRowResult[] = [];
    let stopped = false;
    for (const row of csvRows) {
      if (!row.valid) {
        rows.push({
          rowNo: row.rowNo,
          state: 'NOT_SELECTED',
          code: 'ROW_INVALID',
          fieldErrors: row.fieldErrors,
        });
        continue;
      }
      if (stopped || Date.now() - startedAt > C360_IMPORT_CONFIRM_BUDGET_MS) {
        stopped = true;
        rows.push({ rowNo: row.rowNo, state: 'NOT_ATTEMPTED' });
        continue;
      }
      const normalized = normalizeC360ImportRow(preview.headers, row.cells, mapping);
      if (!normalized.valid) {
        // preview เดียวกันต้องได้ผลเดิม; ถ้าไม่ใช่ถือว่า plan เปลี่ยน
        throw new Customer360HttpError(409, 'PREVIEW_STALE');
      }
      const profile = normalized.profile;
      let current: C360VerifiedActor | undefined;
      const authorization: C360CommandAuthorization = {
        authorize: async (tx) => {
          current = await c360CurrentActor(tx, identity);
          if (current.role !== 'ADMIN' || !(await authorizeC360ContactCreate(tx, current)))
            throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
        },
        canReadRef: async (tx, ref) =>
          ref.type === 'CONTACT' &&
          !!current &&
          (await authorizeC360ContactAccess(tx, current, ref.id)).decision === 'ALLOW',
      };
      try {
        const result = await executeC360ProfileCommand(
          this.db,
          actor,
          {
            commandId: c360ImportChildCommandId(commandId, preview.planHash, row.rowNo),
            action: 'CONTACT_CREATE',
            resourceType: 'CONTACT',
            resourceId: null,
            expectedRevisions: {},
            normalizationContractVersion: C360_PROFILE_WRITE_VERSION,
            normalizedRequest: profile,
          },
          authorization,
          async (tx, command) => {
            const verified = await c360CurrentActor(tx, identity);
            return createC360Profile(tx, verified, actor, command, profile);
          },
        );
        rows.push(c360ImportRowResult(row.rowNo, result));
      } catch (error) {
        const denied =
          (error instanceof Customer360HttpError && [401, 403].includes(error.status)) ||
          (error instanceof C360ProfileCommandError && [401, 403].includes(error.httpStatus));
        if (denied) {
          // สิทธิ์หายกลางทาง: แถวที่ commit แล้วคงอยู่ ที่เหลือไม่ถูกเริ่ม
          stopped = true;
          rows.push({ rowNo: row.rowNo, state: 'NOT_ATTEMPTED', code: 'CUSTOMER_ACCESS_DENIED' });
        } else {
          // ไม่ทราบว่า command ถึง DB หรือไม่: ห้ามสรุปว่าล้ม ให้ส่งซ้ำด้วย commandId เดิม
          rows.push({ rowNo: row.rowNo, state: 'UNKNOWN', code: 'RETRY_SAME_COMMAND' });
        }
      }
    }
    const count = (state: C360ImportRowState) => rows.filter((row) => row.state === state).length;
    const counts = {
      applied: count('APPLIED'),
      rejected: count('REJECTED'),
      notSelected: count('NOT_SELECTED'),
      pending: count('PENDING'),
      unknown: count('UNKNOWN'),
      notAttempted: count('NOT_ATTEMPTED'),
    };
    this.json(response, 200, {
      state: counts.pending + counts.unknown + counts.notAttempted > 0 ? 'INCOMPLETE' : 'COMPLETED',
      planHash: preview.planHash,
      counts,
      rows,
    });
  }

  private ensureWriteRuntime(): void {
    if (!this.runtime.ready) throw new Customer360HttpError(503, 'WRITE_RUNTIME_UNAVAILABLE', true);
  }

  private async consume(identity: C360RequestIdentity): Promise<void> {
    let limited: { retryAfterSeconds: number } | null;
    try {
      limited = await this.limiter.consume({
        tenantId: identity.tenantId,
        actorId: identity.userId,
        policy: C360_IMPORT_POLICY,
      });
    } catch {
      throw new Customer360HttpError(503, 'RATE_LIMITER_UNAVAILABLE', true);
    }
    if (limited)
      throw new Customer360HttpError(429, 'RATE_LIMITED', true, limited.retryAfterSeconds);
  }

  private async read(req: AuthenticatedGatewayRequest): Promise<C360ImportMultipart> {
    try {
      return await readC360ImportMultipart(req);
    } catch (error) {
      (req as unknown as { res?: ServerResponse }).res?.setHeader('Connection', 'close');
      return intakeError(error);
    }
  }

  private async prepare(
    identity: C360RequestIdentity,
    input: C360ImportMultipart,
  ): Promise<{
    preview: PreviewResult;
    mapping: ReturnType<typeof validateC360ImportMapping>;
  }> {
    let rawMapping: unknown;
    try {
      rawMapping = JSON.parse(input.fields.mapping ?? '');
    } catch {
      throw new Customer360HttpError(400, 'MAPPING_INVALID');
    }
    const bytes = new Uint8Array(input.bytes);
    const verify = async (
      tx: Parameters<Parameters<typeof withTenantDatabaseTransaction>[2]>[0],
    ) => {
      const actor = await c360CurrentActor(tx, identity);
      if (actor.role !== 'ADMIN' || !(await authorizeC360ContactCreate(tx, actor)))
        throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
      return actor;
    };
    try {
      return await withTenantDatabaseTransaction(
        this.db,
        identity.tenantId,
        async (tx) => {
          const actor = await verify(tx);
          const preview = await prepareC360ImportPreview({
            source: bytes,
            sourceDigest: createHash('sha256').update(bytes).digest('hex'),
            mapping: rawMapping,
            duplicateAuthority: createC360ImportDuplicateAuthority(tx, actor),
          });
          await verify(tx);
          const mapping = validateC360ImportMapping(rawMapping, preview.headers);
          return { preview, mapping };
        },
        { timeout: 20_000 },
      );
    } catch (error) {
      return importError(error);
    }
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify(body));
  }
}

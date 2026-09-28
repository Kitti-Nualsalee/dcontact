/**
 * U1.5 (#433) — หลักฐานภาพหน้าจอ, negative scan และ evidence bundle ของ UAT run
 *
 * Authority: Phase Contract #374, evidence/defect #379
 *
 * - สิทธิ์เหมือน route อื่นของ uat-runs: tenant/actor จาก verified token, ต้องเป็นผู้ทดสอบของ pack;
 *   run ของ tenant อื่นหรือไม่ใช่ผู้ทดสอบ = 404 `UAT_RUN_NOT_FOUND`
 * - อัปโหลดเป็น raw body `image/png`/`image/jpeg` (ไม่ใช่ multipart) พร้อม `Idempotency-Key` และ `x-uat-step-id`
 *   อ่าน stream เองพร้อมเพดานขนาด — body parser JSON ของแอปไม่แตะ content type ของภาพ
 * - byte ของภาพกลับไปทาง API เท่านั้น (`Cache-Control: private, no-store`, `nosniff`) ไม่มี URL ของ storage
 */
import type { ServerResponse } from 'node:http';
import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  UAT_EVIDENCE_CONTENT_TYPES,
  UAT_EVIDENCE_MAX_BYTES,
  UatRunError,
  type UatEvidenceRepository,
} from '@d-contact/journey';
import type { AuthenticatedGatewayRequest } from './gateway-auth.js';
import {
  RequestMalformed,
  authoringActor,
  commandContext,
  pathUuid,
} from './journey-authoring-api.js';
import { handle } from './uat-run-api.js';

export const UAT_EVIDENCE_REPOSITORY = Symbol('UAT_EVIDENCE_REPOSITORY');

const STEP_ID = /^[A-Z][A-Z0-9_-]{1,63}$/;

function header(request: AuthenticatedGatewayRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** อ่าน raw body เองพร้อมเพดาน — เกินเพดานทิ้ง byte ที่เหลือแล้วตอบ 413 */
async function readScreenshot(request: AuthenticatedGatewayRequest): Promise<Buffer> {
  const tooLarge = () => {
    request.resume();
    return new UatRunError('EVIDENCE_TOO_LARGE', { maxBytes: UAT_EVIDENCE_MAX_BYTES });
  };
  const declared = Number(header(request, 'content-length'));
  if (Number.isFinite(declared) && declared > UAT_EVIDENCE_MAX_BYTES) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > UAT_EVIDENCE_MAX_BYTES) throw tooLarge();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function noStore(response: ServerResponse) {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

@Controller('api/v1/uat-runs')
export class UatEvidenceController {
  constructor(
    @Inject(UAT_EVIDENCE_REPOSITORY) private readonly repository: UatEvidenceRepository,
  ) {}

  /** อัปโหลดภาพหน้าจอหนึ่งไฟล์ของ step ใน catalog ของ run */
  @Post(':runId/evidence')
  @HttpCode(200)
  upload(@Req() request: AuthenticatedGatewayRequest, @Param('runId') runId: string) {
    const id = pathUuid(runId, 'runId');
    const stepId = header(request, 'x-uat-step-id');
    if (!stepId || !STEP_ID.test(stepId)) throw new RequestMalformed('x-uat-step-id');
    const context = commandContext(request);
    const contentType = (header(request, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    return handle(async () => {
      // HAR/JSON/zip/text ไม่ถูกอ่านเลย — content type ต้องเป็นภาพ แล้ว domain ตรวจ magic bytes ซ้ำ
      if (!(UAT_EVIDENCE_CONTENT_TYPES as readonly string[]).includes(contentType)) {
        request.resume();
        throw new UatRunError('EVIDENCE_TYPE_REJECTED', { reason: 'CONTENT_TYPE' });
      }
      const bytes = await readScreenshot(request);
      return this.repository.record(context, { runId: id, stepId, contentType, bytes });
    });
  }

  @Get(':runId/evidence')
  list(@Req() request: AuthenticatedGatewayRequest, @Param('runId') runId: string) {
    const { tenantId, actor } = authoringActor(request);
    const id = pathUuid(runId, 'runId');
    return handle(() => this.repository.list(tenantId, actor, id));
  }

  /** byte ของภาพผ่าน API เท่านั้น — ไม่มี redirect ไป storage */
  @Get(':runId/evidence/:evidenceId/content')
  async content(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('runId') runId: string,
    @Param('evidenceId') evidenceId: string,
  ) {
    const { tenantId, actor } = authoringActor(request);
    const id = pathUuid(runId, 'runId');
    const evidence = pathUuid(evidenceId, 'evidenceId');
    noStore(response);
    const found = await handle(() => this.repository.content(tenantId, actor, id, evidence));
    response.setHeader('ETag', `"${found.sha256}"`);
    return new StreamableFile(Buffer.from(found.bytes), {
      type: found.contentType,
      length: found.bytes.byteLength,
      disposition: `attachment; filename="${evidence}.${found.contentType === 'image/png' ? 'png' : 'jpg'}"`,
    });
  }

  /** negative scan ของ run — idempotent ต่อเนื้อหา จึงไม่ต้องใช้ `Idempotency-Key` */
  @Post(':runId/scan')
  @HttpCode(200)
  scan(@Req() request: AuthenticatedGatewayRequest, @Param('runId') runId: string) {
    const { tenantId, actor } = authoringActor(request);
    const id = pathUuid(runId, 'runId');
    return handle(() => this.repository.scan(tenantId, actor, id));
  }

  /** evidence bundle (JSON) — scan ให้เป็นปัจจุบันก่อนเสมอ; ไม่มี byte ของภาพ */
  @Get(':runId/bundle')
  bundle(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('runId') runId: string,
  ) {
    const { tenantId, actor } = authoringActor(request);
    const id = pathUuid(runId, 'runId');
    noStore(response);
    return handle(() => this.repository.bundle(tenantId, actor, id));
  }
}

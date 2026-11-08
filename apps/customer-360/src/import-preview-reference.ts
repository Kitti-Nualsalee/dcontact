import { c360Uuid } from './profile-command.js';
import { C360ReadError, c360FilterDigest, type C360CursorCodec } from './profile-read.js';

/** Caller ต้องพิสูจน์ current actor/job ownership/capability และ scope ก่อนเรียกทุกครั้ง */
export interface C360ImportPreviewContext {
  tenantId: string;
  userId: string;
  jobId: string;
  actorKey: string;
  scopeDigest: string;
  revision: string;
  planHash: string;
}

function expected(context: C360ImportPreviewContext, kind: 'preview' | 'preview-rows') {
  const tenantId = c360Uuid(context.tenantId);
  const userId = c360Uuid(context.userId);
  const jobId = c360Uuid(context.jobId);
  if (
    !/^[a-f0-9]{64}$/.test(context.actorKey) ||
    !/^[a-f0-9]{64}$/.test(context.scopeDigest) ||
    !/^[a-f0-9]{64}$/.test(context.planHash) ||
    !/^(0|[1-9][0-9]{0,18})$/.test(context.revision) ||
    BigInt(context.revision) > 9223372036854775807n
  )
    throw new C360ReadError(400, 'CURSOR_INVALID');
  return {
    kind: `import-${kind}-v1`,
    tenantId,
    userId,
    filter: c360FilterDigest([jobId, context.actorKey, context.revision, context.planHash]),
    scope: context.scopeDigest,
  };
}

/** previewRef มีอายุ 15 นาทีตาม codec และใช้ confirm เฉพาะ context/plan เดิม */
export function sealC360ImportPreviewRef(
  codec: C360CursorCodec,
  context: C360ImportPreviewContext,
): string {
  return codec.seal({ ...expected(context, 'preview'), position: [] });
}
export function openC360ImportPreviewRef(
  codec: C360CursorCodec,
  token: string,
  context: C360ImportPreviewContext,
): void {
  const position = codec.open(token, expected(context, 'preview'), {
    distinguishScopeChange: true,
  });
  if (position.length !== 0) throw new C360ReadError(400, 'CURSOR_INVALID');
}

/** cursor ผูก previewRef ต้นฉบับด้วย ไม่ยืดอายุ preview โดยออก cursor ใหม่ */
export function sealC360ImportRowsCursor(
  codec: C360CursorCodec,
  context: C360ImportPreviewContext,
  previewRef: string,
  lastRowNo: number,
): string {
  openC360ImportPreviewRef(codec, previewRef, context);
  if (!Number.isSafeInteger(lastRowNo) || lastRowNo < 1 || lastRowNo > 10_000)
    throw new C360ReadError(400, 'CURSOR_INVALID');
  const base = expected(context, 'preview-rows');
  return codec.seal({
    ...base,
    filter: c360FilterDigest([base.filter, previewRef]),
    position: [String(lastRowNo)],
  });
}
export function openC360ImportRowsCursor(
  codec: C360CursorCodec,
  token: string,
  context: C360ImportPreviewContext,
  previewRef: string,
): number {
  openC360ImportPreviewRef(codec, previewRef, context);
  const base = expected(context, 'preview-rows');
  const position = codec.open(
    token,
    { ...base, filter: c360FilterDigest([base.filter, previewRef]) },
    { distinguishScopeChange: true },
  );
  if (
    position.length !== 1 ||
    !/^[1-9][0-9]{0,4}$/.test(position[0]!) ||
    Number(position[0]) > 10_000
  )
    throw new C360ReadError(400, 'CURSOR_INVALID');
  return Number(position[0]);
}

import type { IncomingMessage } from 'node:http';
import { Transform } from 'node:stream';
import Busboy from 'busboy';
import { c360Uuid } from '@d-contact/customer-360';

const FILE_LIMIT = 5 * 1024 * 1024;
const ENVELOPE_LIMIT = FILE_LIMIT + 64 * 1024;
const MAX_IN_FLIGHT = 4;
let inFlight = 0;

export class C360ImportIntakeError extends Error {
  constructor(
    readonly status: 400 | 408 | 413 | 503,
    readonly code: string,
  ) {
    super(code);
    this.name = 'C360ImportIntakeError';
  }
}

/** หยุดอ่านทันที ให้ caller ส่ง error พร้อม Connection: close ก่อน watchdog ปิด socket */
function stopRejectedInput(request: IncomingMessage): void {
  request.pause();
  const watchdog = setTimeout(() => request.destroy(), 2_000);
  watchdog.unref();
  request.once('close', () => clearTimeout(watchdog));
}

/**
 * อ่านเฉพาะหลัง gateway และ active ADMIN/proof/capability ผ่านแล้ว;
 * caller ต้องตรวจสิทธิ์ใหม่ก่อน attach และห้ามบันทึก filename/body ใน log.
 * เมื่อ stream ผิดหรือ timeout จะหยุดอ่าน; caller ต้องส่ง error พร้อม Connection: close
 */
export async function readC360ImportMultipart(
  request: IncomingMessage,
  options: { timeoutMs?: number } = {},
): Promise<{ commandId: string; bytes: Buffer }> {
  if (inFlight >= MAX_IN_FLIGHT) {
    stopRejectedInput(request);
    throw new C360ImportIntakeError(503, 'RESOURCE_BUSY');
  }
  inFlight++;
  try {
    return await parse(request, options.timeoutMs ?? 30_000);
  } finally {
    inFlight--;
  }
}

function parse(
  request: IncomingMessage,
  timeoutMs: number,
): Promise<{ commandId: string; bytes: Buffer }> {
  const bad = () => new C360ImportIntakeError(400, 'CSV_INVALID');
  const big = () => new C360ImportIntakeError(413, 'IMPORT_LIMIT_EXCEEDED');
  if (request.aborted || request.destroyed) return Promise.reject(bad());
  const rejectEarly = (error: C360ImportIntakeError) => {
    stopRejectedInput(request);
    return Promise.reject(error);
  };
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')
    return rejectEarly(bad());
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > ENVELOPE_LIMIT))
    return rejectEarly(/^\d+$/.test(length) ? big() : bad());
  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: request.headers,
      limits: { fileSize: FILE_LIMIT + 1, fieldSize: 37, files: 1, fields: 1, parts: 3 },
    });
  } catch {
    return rejectEarly(bad());
  }
  return new Promise((resolve, reject) => {
    let done = false;
    let fileCount = 0;
    let fieldCount = 0;
    let commandId: string | undefined;
    let fileSize = 0;
    let envelopeSize = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      clearTimeout(timer);
      request.off('aborted', onAbort);
      request.off('error', onError);
    };
    const fail = (error: C360ImportIntakeError) => {
      if (done) return;
      done = true;
      cleanup();
      stopRejectedInput(request);
      // Busboy อาจกำลังส่ง event จาก parser ภายใน; ปิดหลัง callback กลับเพื่อลด re-entrancy
      queueMicrotask(() => {
        request.unpipe(counter);
        counter.unpipe(parser);
        counter.destroy();
        parser.destroy();
      });
      reject(error);
    };
    const onAbort = () => fail(bad());
    const onError = () => fail(bad());
    const timer = setTimeout(
      () => fail(new C360ImportIntakeError(408, 'IMPORT_TIMEOUT')),
      timeoutMs,
    );
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        envelopeSize += chunk.length;
        if (envelopeSize > ENVELOPE_LIMIT) {
          callback(big());
          return;
        }
        callback(null, chunk);
      },
    });
    request.once('aborted', onAbort);
    request.once('error', onError);
    counter.once('error', (error) => fail(error instanceof C360ImportIntakeError ? error : bad()));
    parser.once('error', () => fail(bad()));
    parser.on('filesLimit', () => fail(bad()));
    parser.on('fieldsLimit', () => fail(bad()));
    parser.on('partsLimit', () => fail(bad()));
    parser.on('field', (name, value, info) => {
      fieldCount++;
      if (
        name !== 'commandId' ||
        fieldCount !== 1 ||
        info.valueTruncated ||
        !['7bit', '8bit', 'binary'].includes(info.encoding)
      )
        return fail(bad());
      try {
        commandId = c360Uuid(value);
      } catch {
        fail(bad());
      }
    });
    parser.on('file', (name, file, info) => {
      fileCount++;
      file.once('error', () => fail(bad()));
      if (
        name !== 'file' ||
        fileCount !== 1 ||
        !['7bit', '8bit', 'binary'].includes(info.encoding)
      ) {
        file.resume();
        fail(bad());
        return;
      }
      file.on('data', (chunk: Buffer) => {
        fileSize += chunk.length;
        if (fileSize > FILE_LIMIT) return fail(big());
        chunks.push(chunk);
      });
      file.once('limit', () => fail(big()));
    });
    parser.once('close', () => {
      if (done) return;
      if (fileCount !== 1 || fieldCount !== 1 || !commandId) return fail(bad());
      done = true;
      cleanup();
      resolve({ commandId, bytes: Buffer.concat(chunks, fileSize) });
    });
    request.pipe(counter).pipe(parser);
  });
}

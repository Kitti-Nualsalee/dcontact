import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { C360ImportIntakeError, readC360ImportMultipart } from './customer-360-import-multipart.js';

const boundary = 'synthetic-boundary-837';
const field = (name: string, value: string) =>
  Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
const file = (name: string, value: Buffer) =>
  Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="secret-file.csv"\r\nContent-Type: text/csv\r\n\r\n`,
    ),
    value,
    Buffer.from('\r\n'),
  ]);
const end = Buffer.from(`--${boundary}--\r\n`);
function request(headers: Record<string, string> = {}) {
  const stream = new PassThrough() as PassThrough & { headers: Record<string, string> };
  stream.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, ...headers };
  return stream;
}
const read = (stream: PassThrough, timeoutMs?: number) =>
  readC360ImportMultipart(stream as unknown as IncomingMessage, { timeoutMs });

async function parse(parts: Buffer[], headers?: Record<string, string>) {
  const stream = request(headers);
  const result = read(stream);
  stream.end(Buffer.concat(parts));
  return result;
}

test('multipart accepts file and commandId in either order without keeping the filename', async () => {
  const id = randomUUID();
  const result = await parse([file('file', Buffer.from('name\nก')), field('commandId', id), end]); // allow-thai: Thai UTF-8 bytes through multipart
  assert.equal(result.fields.commandId, id);
  assert.equal(result.bytes.toString(), 'name\nก'); // allow-thai: Thai UTF-8 bytes through multipart
  assert.ok(!('filename' in result));
});

test('multipart accepts a file of exactly 1 MiB and rejects one byte over', async () => {
  const id = randomUUID();
  const max = Buffer.alloc(1024 * 1024, 0x61);
  assert.equal(
    (await parse([field('commandId', id), file('file', max), end])).bytes.length,
    max.length,
  );
  await assert.rejects(
    parse([field('commandId', id), file('file', Buffer.alloc(max.length + 1)), end]),
    { code: 'IMPORT_LIMIT_EXCEEDED' },
  );
});

test('multipart rejects a duplicate field/file, unknown, a wrong closing boundary and the body encoding', async () => {
  const id = randomUUID();
  for (const parts of [
    [field('commandId', id), field('commandId', id), file('file', Buffer.from('a')), end],
    [field('commandId', id), file('unknown', Buffer.from('a')), end],
    [field('commandId', id), file('file', Buffer.from('a')), file('file', Buffer.from('b')), end],
    [field('mapping', 'x'.repeat(4097)), file('file', Buffer.from('a')), end],
    [field('commandId', id), end],
    [field('commandId', id), file('file', Buffer.from('a'))],
  ]) {
    await assert.rejects(parse(parts), (error: unknown) => {
      assert.ok(error instanceof C360ImportIntakeError);
      assert.equal(error.code, 'CSV_INVALID');
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
  }
  await assert.rejects(parse([], { 'content-encoding': 'gzip' }), { code: 'CSV_INVALID' });
});

test('multipart limits concurrency and returns the permit on timeout', async () => {
  const streams = Array.from({ length: 4 }, () => request());
  const pending = Promise.allSettled(streams.map((stream) => read(stream, 80)));
  await assert.rejects(read(request(), 80), { code: 'RESOURCE_BUSY' });
  const results = await pending;
  assert.ok(
    results.every(
      (result) => result.status === 'rejected' && result.reason.code === 'IMPORT_TIMEOUT',
    ),
  );
  const id = randomUUID();
  assert.equal(
    (await parse([field('commandId', id), file('file', Buffer.from('x')), end])).fields.commandId,
    id,
  );
});

test('multipart reads the boundary and UTF-8 split across several chunks while keeping the bytes', async () => {
  const id = randomUUID();
  const body = Buffer.concat([
    field('commandId', id),
    file('file', Buffer.from('ชื่อ\nสมชาย')), // allow-thai: Thai UTF-8 bytes split across chunks
    end,
  ]);
  const stream = request();
  const result = read(stream);
  for (let i = 0; i < body.length; i++) stream.write(body.subarray(i, i + 1));
  stream.end();
  assert.equal((await result).bytes.toString('utf8'), 'ชื่อ\nสมชาย'); // allow-thai: Thai UTF-8 bytes split across chunks
});

test('multipart accepts mapping/planHash as text fields together with the file', async () => {
  const result = await parse([
    field('mapping', '{"version":1}'),
    field('planHash', 'a'.repeat(64)),
    file('file', Buffer.from('a')),
    end,
  ]);
  assert.deepEqual(result.fields, { mapping: '{"version":1}', planHash: 'a'.repeat(64) });
});

test('multipart returns an error that does not echo the input when the client aborts', async () => {
  const stream = request();
  const result = read(stream);
  stream.write(Buffer.from(`--${boundary}\r\n`));
  stream.emit('aborted');
  await assert.rejects(result, { code: 'CSV_INVALID' });
  const alreadyClosed = request();
  alreadyClosed.destroy();
  await assert.rejects(read(alreadyClosed), { code: 'CSV_INVALID' });
});

test('real HTTP sends 400/413/408 before closing the connection when the input is rejected', async (t) => {
  const { createServer, request: httpRequest } = await import('node:http');
  const server = createServer((req, res) => {
    readC360ImportMultipart(req, { timeoutMs: 100 }).then(
      () => {
        res.statusCode = 204;
        res.end();
      },
      (error: C360ImportIntakeError) => {
        res.statusCode = error.status;
        res.setHeader('connection', 'close');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify({ code: error.code }));
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const send = (headers: Record<string, string>, body?: Buffer, leaveOpen = false) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const client = httpRequest(
        { host: '127.0.0.1', port: address.port, method: 'POST', headers },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode!, text: Buffer.concat(chunks).toString() }),
          );
        },
      );
      client.on('error', reject);
      if (body && leaveOpen) client.write(body);
      else if (body) client.end(body);
      else client.flushHeaders();
    });
  const headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  const invalid = await send(
    headers,
    Buffer.concat([field('secret-field', 'x'), file('file', Buffer.from('a')), end]),
  );
  assert.deepEqual(invalid, { status: 400, text: '{"code":"CSV_INVALID"}' });
  const oversized = await send({ ...headers, 'content-length': String(2 * 1024 * 1024) });
  assert.deepEqual(oversized, { status: 413, text: '{"code":"IMPORT_LIMIT_EXCEEDED"}' });
  const oversizedChunked = await send(
    { ...headers, 'transfer-encoding': 'chunked' },
    Buffer.concat([
      field('commandId', randomUUID()),
      file('file', Buffer.alloc(1024 * 1024 + 1)),
      end,
    ]),
  );
  assert.deepEqual(oversizedChunked, { status: 413, text: '{"code":"IMPORT_LIMIT_EXCEEDED"}' });
  const timedOut = await send({ ...headers, 'transfer-encoding': 'chunked' });
  assert.deepEqual(timedOut, { status: 408, text: '{"code":"IMPORT_TIMEOUT"}' });
  const partialUnknown = await send(
    headers,
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="unknown"; filename="private.csv"\r\nContent-Type: text/csv\r\n\r\npartial`,
    ),
    true,
  );
  assert.deepEqual(partialUnknown, { status: 400, text: '{"code":"CSV_INVALID"}' });
});

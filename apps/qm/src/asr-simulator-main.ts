/**
 * HTTP server ของ ASR simulator (D-Contact ASR Provider Protocol v1)
 * ฟัง HTTP ธรรมดา: TLS จบที่ reverse proxy ข้างหน้า เพราะ QM ส่งคำขอไปที่ endpoint แบบ HTTPS เท่านั้น
 *
 *   ASR_SIMULATOR_API_KEY       bearer token ที่ QM ส่งมา (ค่าเดียวกับ QM_TRANSCRIPTION_API_KEY)
 *   ASR_SIMULATOR_MEDIA_HOSTS   hostname ที่ดาวน์โหลด media ได้ คั่นด้วย comma (host ของ QM_MEDIA_ENDPOINT)
 *   ASR_SIMULATOR_MAX_MEDIA_MB  เพดานขนาดไฟล์เสียง ค่าเริ่มต้น 128
 *   PORT                        ค่าเริ่มต้น 8090
 */
import { createServer } from 'node:http';
import { AsrSimulator, readSimulatorRequest, writeSimulatorResponse } from './asr-simulator.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

const simulator = new AsrSimulator({
  apiKey: required('ASR_SIMULATOR_API_KEY'),
  mediaHosts: required('ASR_SIMULATOR_MEDIA_HOSTS').split(','),
  maxMediaBytes: positiveInteger('ASR_SIMULATOR_MAX_MEDIA_MB', 128) * 1024 * 1024,
});
const port = positiveInteger('PORT', 8090);

const server = createServer((request, response) => {
  const started = Date.now();
  void readSimulatorRequest(request)
    .then(async (input) => {
      const result = await simulator.handle(input);
      writeSimulatorResponse(response, result, input.method);
      if (input.path !== '/v1/health') {
        // ไม่ log mediaUrl: query string เป็น signature ที่ใช้อ่านไฟล์เสียงได้
        console.log(
          JSON.stringify({
            msg: 'asr-simulator request',
            method: input.method,
            path: input.path,
            ms: Date.now() - started,
            ...result.log,
          }),
        );
      }
    })
    .catch((error: unknown) => {
      console.error('[asr-simulator] request failed', error);
      if (!response.headersSent) {
        writeSimulatorResponse(
          response,
          { status: 500, body: { error: { code: 'INTERNAL', message: 'simulator failed' } } },
          'POST',
        );
      } else {
        response.destroy();
      }
    });
});
server.requestTimeout = 120_000;
server.headersTimeout = 15_000;
server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ msg: 'asr-simulator listening', port, simulated: true }));
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { runAsrProviderContract } from './asr-provider-contract.js';
import {
  ASR_SIMULATOR_MODEL_ID,
  AsrSimulator,
  readSimulatorRequest,
  writeSimulatorResponse,
} from './asr-simulator.js';
import { HttpTranscriptionProvider } from './http-transcription-provider.js';
import { detectSpeechRegions, parsePcmWav, WavFormatError } from './wav-speech-regions.js';

const SAMPLE_RATE = 8_000;
const API_KEY = 'contract-test-key';
const MEDIA_HOST = 'media.test';
const ASR_ENDPOINT = 'https://asr.test/v1/transcriptions';
const NOW = new Date('2026-11-23T03:00:00.000Z');

interface Burst {
  channel: number;
  startMs: number;
  endMs: number;
}

/** WAV PCM 16-bit ที่มี tone 440 Hz ในช่วงที่กำหนด ส่วนอื่นเป็นเสียงรบกวนเบา ๆ แบบ deterministic */
function buildWav(input: { channels: number; durationMs: number; bursts: Burst[] }): Buffer {
  const frames = Math.round((SAMPLE_RATE * input.durationMs) / 1_000);
  const data = Buffer.alloc(frames * input.channels * 2);
  let seed = 7;
  for (let frame = 0; frame < frames; frame += 1) {
    const ms = (frame * 1_000) / SAMPLE_RATE;
    for (let channel = 0; channel < input.channels; channel += 1) {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      let value = (seed % 61) - 30;
      if (
        input.bursts.some(
          (burst) => burst.channel === channel && ms >= burst.startMs && ms < burst.endMs,
        )
      ) {
        value += Math.round(8_000 * Math.sin((2 * Math.PI * 440 * frame) / SAMPLE_RATE));
      }
      data.writeInt16LE(value, (frame * input.channels + channel) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(input.channels, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * input.channels * 2, 28);
  header.writeUInt16LE(input.channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ซ้าย (channel 0) = ลูกค้า, ขวา (channel 1) = Agent ตาม RECORD_STEREO ของ FreeSWITCH
const STEREO = buildWav({
  channels: 2,
  durationMs: 6_000,
  bursts: [
    { channel: 1, startMs: 500, endMs: 1_700 },
    { channel: 0, startMs: 2_000, endMs: 3_500 },
    { channel: 1, startMs: 3_900, endMs: 5_400 },
  ],
});
const MONO = buildWav({
  channels: 1,
  durationMs: 4_000,
  bursts: [
    { channel: 0, startMs: 300, endMs: 1_200 },
    { channel: 0, startMs: 2_000, endMs: 3_200 },
  ],
});
const SILENT = buildWav({ channels: 2, durationMs: 2_000, bursts: [] });

const MEDIA: Record<string, Buffer> = {
  '/recordings/demo/stereo.wav': STEREO,
  '/recordings/demo/mono.wav': MONO,
  '/recordings/demo/silent.wav': SILENT,
  '/recordings/demo/not-wav.wav': Buffer.from('not a wav file'),
};

/** media host จำลองที่ตอบเฉพาะ URL ที่มี signature */
async function mediaFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const media = MEDIA[url.pathname];
  if (url.hostname !== MEDIA_HOST || !url.searchParams.get('X-Amz-Signature') || !media) {
    return new Response('forbidden', { status: 403 });
  }
  return new Response(new Uint8Array(media), {
    status: 200,
    headers: { 'content-length': String(media.length), 'content-type': 'audio/wav' },
  });
}

function mediaUrl(name: string): string {
  return `https://${MEDIA_HOST}/recordings/demo/${name}?X-Amz-Signature=test`;
}

function createSimulator(overrides: Partial<ConstructorParameters<typeof AsrSimulator>[0]> = {}) {
  return new AsrSimulator({
    apiKey: API_KEY,
    mediaHosts: [MEDIA_HOST],
    fetch: mediaFetch,
    now: () => NOW,
    ...overrides,
  });
}

/** fetch ที่ส่งคำขอเข้า simulator ตรง ๆ แทน network (endpoint ของ QM ต้องเป็น https) */
function simulatorFetch(simulator: AsrSimulator) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const result = await simulator.handle({
      method: init?.method ?? 'GET',
      path: url.pathname,
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('parsePcmWav reads mono and stereo PCM 16-bit and rejects other formats', () => {
  const stereo = parsePcmWav(STEREO);
  assert.equal(stereo.channels, 2);
  assert.equal(stereo.sampleRate, SAMPLE_RATE);
  assert.equal(stereo.durationMs, 6_000);
  assert.equal(parsePcmWav(MONO).channels, 1);
  assert.throws(() => parsePcmWav(Buffer.from('nope')), WavFormatError);
  const eightBit = Buffer.from(MONO);
  eightBit.writeUInt16LE(8, 34);
  assert.throws(() => parsePcmWav(eightBit), /16-bit/);
});

test('detectSpeechRegions finds the bursts of each channel', () => {
  const wav = parsePcmWav(STEREO);
  const near = (actual: number, expected: number) => Math.abs(actual - expected) <= 40;
  const contact = detectSpeechRegions(wav, 0);
  assert.equal(contact.length, 1);
  assert.ok(
    near(contact[0]!.startMs, 2_000) && near(contact[0]!.endMs, 3_500),
    JSON.stringify(contact),
  );
  const agent = detectSpeechRegions(wav, 1);
  assert.equal(agent.length, 2, JSON.stringify(agent));
  assert.ok(near(agent[1]!.startMs, 3_900) && near(agent[1]!.endMs, 5_400));
  assert.deepEqual(detectSpeechRegions(parsePcmWav(SILENT), 0), []);
});

test('ASR simulator passes the D-Contact ASR Provider Protocol v1 contract', async () => {
  const checks = await runAsrProviderContract({
    endpoint: ASR_ENDPOINT,
    apiKey: API_KEY,
    stereoMediaUrl: mediaUrl('stereo.wav'),
    stereoDurationMs: 6_000,
    expectedSpeakers: [
      { speaker: 'AGENT', startMs: 500, endMs: 1_700 },
      { speaker: 'CONTACT', startMs: 2_000, endMs: 3_500 },
      { speaker: 'AGENT', startMs: 3_900, endMs: 5_400 },
    ],
    fetch: simulatorFetch(createSimulator()),
    now: () => NOW,
  });
  const failed = checks.filter((check) => !check.ok);
  assert.deepEqual(failed, []);
  assert.ok(checks.length >= 10);
});

test('QM HttpTranscriptionProvider gets simulated STEREO segments from the simulator', async () => {
  const provider = new HttpTranscriptionProvider(
    { id: 'dcontact-asr-simulator', endpoint: ASR_ENDPOINT, apiKey: API_KEY },
    simulatorFetch(createSimulator()),
  );
  const result = await provider.transcribe({
    mediaUrl: mediaUrl('stereo.wav'),
    mediaUrlExpiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
    channelLayout: 'STEREO',
    languageHint: 'th-TH',
    dataUse: 'NO_TRAINING',
  });
  assert.equal(result.modelId, ASR_SIMULATOR_MODEL_ID);
  assert.equal(result.language, 'th-TH');
  assert.deepEqual(
    result.segments.map((segment) => segment.speaker),
    ['AGENT', 'CONTACT', 'AGENT'],
  );
  assert.ok(result.segments.every((segment) => segment.text.startsWith('[จำลอง] ')));
  assert.notEqual(result.segments[0]!.text, result.segments[2]!.text);
  // field ที่ไม่อยู่ใน protocol (simulated) ไม่หลุดเข้า QM
  assert.equal('simulated' in result, false);
});

test('ASR simulator alternates speakers for mono audio and covers silent calls', async () => {
  const simulator = createSimulator();
  const provider = new HttpTranscriptionProvider(
    { id: 'dcontact-asr-simulator', endpoint: ASR_ENDPOINT, apiKey: API_KEY },
    simulatorFetch(simulator),
  );
  const request = (name: string, channelLayout: 'STEREO' | 'PER_LEG') =>
    provider.transcribe({
      mediaUrl: mediaUrl(name),
      mediaUrlExpiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
      channelLayout,
      languageHint: 'th-TH',
      dataUse: 'NO_TRAINING',
    });
  const mono = await request('mono.wav', 'PER_LEG');
  assert.deepEqual(
    mono.segments.map((segment) => segment.speaker),
    ['AGENT', 'CONTACT'],
  );
  const silent = await request('silent.wav', 'STEREO');
  assert.equal(silent.segments.length, 1);
  assert.equal(silent.segments[0]!.speaker, 'SYSTEM');
  assert.equal(silent.segments[0]!.endMs, 2_000);
});

test('ASR simulator reports media problems with protocol error codes', async () => {
  const simulator = createSimulator();
  const call = (name: string, extra: Partial<{ maxMediaBytes: number }> = {}) =>
    (Object.keys(extra).length ? createSimulator(extra) : simulator).handle({
      method: 'POST',
      path: '/v1/transcriptions',
      headers: { authorization: `Bearer ${API_KEY}`, 'x-dcontact-data-use': 'no-training' },
      body: JSON.stringify({
        mediaUrl: mediaUrl(name),
        mediaUrlExpiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
        channelLayout: 'STEREO',
        languageHint: 'th-TH',
        dataUse: 'NO_TRAINING',
      }),
    });
  const codeOf = (result: { body: unknown }) =>
    (result.body as { error?: { code?: string } }).error?.code;

  const notWav = await call('not-wav.wav');
  assert.equal(notWav.status, 422);
  assert.equal(codeOf(notWav), 'MEDIA_UNSUPPORTED');
  const missing = await call('missing.wav');
  assert.equal(missing.status, 502);
  assert.equal(codeOf(missing), 'MEDIA_FETCH_FAILED');
  const tooLarge = await call('stereo.wav', { maxMediaBytes: 1_024 });
  assert.equal(tooLarge.status, 422);
  assert.equal(codeOf(tooLarge), 'MEDIA_TOO_LARGE');

  const otherHost = await simulator.handle({
    method: 'POST',
    path: '/v1/transcriptions',
    headers: { authorization: `Bearer ${API_KEY}`, 'x-dcontact-data-use': 'no-training' },
    body: JSON.stringify({
      mediaUrl: 'https://169.254.169.254/latest/meta-data?X-Amz-Signature=x',
      mediaUrlExpiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
      channelLayout: 'STEREO',
      languageHint: 'th-TH',
      dataUse: 'NO_TRAINING',
    }),
  });
  assert.equal(codeOf(otherHost), 'MEDIA_URL_NOT_ALLOWED');
});

test('ASR simulator HTTP server answers health and rejects oversized bodies', async () => {
  const simulator = createSimulator();
  const server = createServer((request, response) => {
    void readSimulatorRequest(request).then(async (input) => {
      writeSimulatorResponse(response, await simulator.handle(input), input.method);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const health = await fetch(`${base}/v1/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-dcontact-asr-protocol'), '1');
    assert.deepEqual(await health.json(), {
      status: 'ok',
      protocolVersion: '1',
      modelId: ASR_SIMULATOR_MODEL_ID,
      simulated: true,
    });
    const oversized = await fetch(`${base}/v1/transcriptions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'x-dcontact-data-use': 'no-training',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ padding: 'x'.repeat(70_000) }),
    });
    assert.equal(oversized.status, 413);
    const unknown = await fetch(`${base}/v1/other`);
    assert.equal(unknown.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('detectSpeechRegions still finds speech on a channel that is loud for most of the call', () => {
  // เพลงรอสายหรือเสียงวน: เสียงดังเกิน 80% ของสาย ทำให้ noise floor สูงเท่าเสียงพูด
  const looped = parsePcmWav(
    buildWav({
      channels: 1,
      durationMs: 6_000,
      bursts: [{ channel: 0, startMs: 0, endMs: 5_600 }],
    }),
  );
  const regions = detectSpeechRegions(looped, 0);
  assert.equal(regions.length, 1, JSON.stringify(regions));
  assert.ok(regions[0]!.endMs - regions[0]!.startMs >= 5_000);
});

test('parsePcmWav reads to the end of the file when the data size is unset', () => {
  for (const size of [0, 0xffffffff]) {
    const unfinished = Buffer.from(STEREO);
    unfinished.writeUInt32LE(size, 40);
    assert.equal(parsePcmWav(unfinished).durationMs, 6_000);
  }
});

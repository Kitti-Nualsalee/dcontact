import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpTranscriptionProvider } from './http-transcription-provider.js';

test('HTTP transcription provider enforces HTTPS and the no-training contract', async () => {
  assert.throws(
    () =>
      new HttpTranscriptionProvider({
        id: 'insecure',
        endpoint: 'http://asr.test/transcribe',
      }),
    /HTTPS/,
  );

  let captured: { url: string; init?: RequestInit } | undefined;
  const provider = new HttpTranscriptionProvider(
    {
      id: 'thai-provider',
      endpoint: 'https://asr.test/transcribe',
      apiKey: 'secret-for-test',
    },
    async (url, init) => {
      captured = { url: String(url), init };
      return new Response(
        JSON.stringify({
          modelId: 'thai-v1',
          language: 'th-TH',
          confidenceAvg: 0.92,
          segments: [
            {
              speaker: 'AGENT',
              startMs: 0,
              endMs: 1_200,
              text: 'สวัสดีค่ะ',
              confidence: 0.92,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  );

  const result = await provider.transcribe({
    mediaUrl: 'https://storage.test/recording.wav?signed=1',
    mediaUrlExpiresAt: '2026-09-05T06:05:00.000Z',
    channelLayout: 'STEREO',
    languageHint: 'th-TH',
    dataUse: 'NO_TRAINING',
  });

  assert.equal(captured?.url, 'https://asr.test/transcribe');
  assert.equal(new Headers(captured?.init?.headers).get('authorization'), 'Bearer secret-for-test');
  assert.deepEqual(JSON.parse(String(captured?.init?.body)), {
    mediaUrl: 'https://storage.test/recording.wav?signed=1',
    mediaUrlExpiresAt: '2026-09-05T06:05:00.000Z',
    channelLayout: 'STEREO',
    languageHint: 'th-TH',
    dataUse: 'NO_TRAINING',
  });
  assert.equal(result.segments[0]?.text, 'สวัสดีค่ะ');
});

test('HTTP transcription provider sends the protocol header and reports provider error codes', async () => {
  let protocol: string | null = null;
  const provider = new HttpTranscriptionProvider(
    { id: 'thai-provider', endpoint: 'https://asr.test/v1/transcriptions' },
    async (_url, init) => {
      protocol = new Headers(init?.headers).get('x-dcontact-asr-protocol');
      return new Response(
        JSON.stringify({ error: { code: 'MEDIA_UNSUPPORTED', message: 'only PCM WAV' } }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      );
    },
  );
  await assert.rejects(
    provider.transcribe({
      mediaUrl: 'https://storage.test/recording.wav?signed=1',
      mediaUrlExpiresAt: '2026-09-05T06:05:00.000Z',
      channelLayout: 'STEREO',
      languageHint: 'th-TH',
      dataUse: 'NO_TRAINING',
    }),
    /HTTP 422 MEDIA_UNSUPPORTED/,
  );
  assert.equal(protocol, '1');
});

test('HTTP transcription provider rejects responses outside the v1 contract', async () => {
  const respond = (payload: unknown) =>
    new HttpTranscriptionProvider(
      { id: 'thai-provider', endpoint: 'https://asr.test/v1/transcriptions' },
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    ).transcribe({
      mediaUrl: 'https://storage.test/recording.wav?signed=1',
      mediaUrlExpiresAt: '2026-09-05T06:05:00.000Z',
      channelLayout: 'STEREO',
      languageHint: 'th-TH',
      dataUse: 'NO_TRAINING',
    });
  const segment = { speaker: 'AGENT', startMs: 0, endMs: 900, text: 'Hello' };
  const valid = { modelId: 'm', language: 'th-TH', confidenceAvg: 0.9, segments: [segment] };
  await assert.rejects(
    respond({ ...valid, segments: [{ ...segment, speaker: 'CALLER' }] }),
    /speaker/,
  );
  await assert.rejects(
    respond({ ...valid, segments: [{ ...segment, endMs: 0 }] }),
    /startMs < endMs/,
  );
  await assert.rejects(respond({ ...valid, confidenceAvg: 2 }), /confidenceAvg/);
  await assert.rejects(respond({ ...valid, segments: [] }), /at least one segment/);
  const result = await respond({ ...valid, vendorDebug: { raw: true } });
  assert.deepEqual(result, valid);
});

test('HTTP transcription provider stops waiting after the configured timeout', async () => {
  const provider = new HttpTranscriptionProvider(
    { id: 'slow', endpoint: 'https://asr.test/v1/transcriptions', timeoutMs: 20 },
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
  );
  // AbortSignal.timeout uses an unref'd timer: hold a handle so the runner does not finish before the abort
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    await assert.rejects(
      provider.transcribe({
        mediaUrl: 'https://storage.test/recording.wav?signed=1',
        mediaUrlExpiresAt: '2026-09-05T06:05:00.000Z',
        channelLayout: 'STEREO',
        languageHint: 'th-TH',
        dataUse: 'NO_TRAINING',
      }),
      /timed out after 20 ms/,
    );
  } finally {
    clearInterval(keepAlive);
  }
});

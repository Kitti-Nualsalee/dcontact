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

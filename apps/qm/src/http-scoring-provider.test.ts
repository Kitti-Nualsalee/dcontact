import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SCORING_TIMEOUT_MS, HttpScoringProvider } from './http-scoring-provider.js';

const configuration = {
  id: 'scorer',
  endpoint: 'https://scorer.test/v1/score',
  modelId: 'score-v1',
  promptVersion: 'prompt-1',
};
const input = {
  segments: [{ id: 'seg-1', speaker: 'AGENT' as const, startMs: 0, endMs: 1_000, text: 'hello' }],
  context: { interactionId: 'interaction-1', queueName: 'Support', durationSec: 1 },
};

test('HTTP scoring provider stops waiting after the configured timeout', async () => {
  const provider = new HttpScoringProvider(
    { ...configuration, timeoutMs: 20 },
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
  );
  // AbortSignal.timeout uses an unref'd timer: hold a handle so the runner does not finish before the abort
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    await assert.rejects(provider.score(input), /scoring provider timed out after 20 ms/);
  } finally {
    clearInterval(keepAlive);
  }
});

test('HTTP scoring provider has a bounded default timeout and rejects a bad one', async () => {
  assert.equal(DEFAULT_SCORING_TIMEOUT_MS, 120_000);
  assert.throws(
    () => new HttpScoringProvider({ ...configuration, timeoutMs: 0 }),
    /timeout must be a positive integer/,
  );
  let signal: AbortSignal | undefined;
  const provider = new HttpScoringProvider(configuration, async (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Response(JSON.stringify({ answers: [] }), { status: 200 });
  });
  assert.deepEqual(await provider.score(input), { answers: [] });
  assert.ok(signal, 'the request carries an abort signal');
});

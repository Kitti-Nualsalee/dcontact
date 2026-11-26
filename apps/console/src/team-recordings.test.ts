import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUFFER_SECONDS,
  dateRange,
  defaultDates,
  formatClock,
  nextChunk,
  playbackFailure,
  shouldFetch,
} from './team-recordings/model.js';

const format = { sampleRate: 8000, channels: 2, totalFrames: 40_000, maxChunkFrames: 16_000 };

test('request audio at most 2 seconds at a time, and the last range is as short as what remains', () => {
  assert.deepEqual(nextChunk(format, 0), { startFrame: 0, frameCount: 16_000 });
  assert.deepEqual(nextChunk(format, 32_000), { startFrame: 32_000, frameCount: 8_000 });
  assert.equal(nextChunk(format, 40_000), null);
  // when the server announces a ceiling below 2 seconds, do not request more than that ceiling
  assert.equal(nextChunk({ ...format, maxChunkFrames: 4_000 }, 0)?.frameCount, 4_000);
  // when the server announces more than 2 seconds, still request no more than 2 seconds
  assert.equal(nextChunk({ ...format, maxChunkFrames: 80_000 }, 0)?.frameCount, 16_000);
});

test('audio waiting to play plus the range to request is at most 4 seconds', () => {
  assert.equal(BUFFER_SECONDS, 4);
  assert.equal(shouldFetch(0), true);
  assert.equal(shouldFetch(2), true);
  assert.equal(shouldFetch(2.01), false);
  assert.equal(shouldFetch(4), false);
});

test('the date range includes the whole last day, and rejects a range the API does not accept', () => {
  const range = dateRange('2026-11-01', '2026-11-01');
  assert.ok(!('error' in range));
  assert.equal(new Date(range.to).getTime() - new Date(range.from).getTime(), 86_400_000);
  assert.deepEqual(dateRange('2026-11-02', '2026-11-01'), { error: 'ORDER' });
  assert.deepEqual(dateRange('', '2026-11-01'), { error: 'INVALID' });
  assert.deepEqual(dateRange('2026-01-01', '2026-11-01'), { error: 'TOO_LONG' });
  assert.ok(!('error' in dateRange('2026-08-04', '2026-11-01')));
  const defaults = defaultDates(new Date(2026, 10, 22, 15));
  assert.deepEqual(defaults, { from: '2026-11-16', to: '2026-11-22' });
});

test('the reason listening is not possible differs by what the user can do next', () => {
  assert.equal(playbackFailure(401), 'signIn');
  assert.equal(playbackFailure(403, 'PLAYBACK_ACCESS_DENIED'), 'denied');
  assert.equal(playbackFailure(404, 'RESOURCE_NOT_FOUND'), 'gone');
  assert.equal(playbackFailure(409, 'RECORDING_NOT_READY'), 'notReady');
  assert.equal(playbackFailure(409, 'PLAYBACK_SESSION_EXPIRED'), 'failed');
  assert.equal(playbackFailure(422), 'unsupported');
  assert.equal(playbackFailure(503), 'unavailable');
  assert.equal(playbackFailure(0), 'failed');
  assert.equal(formatClock(125.9), '2:05');
  assert.equal(formatClock(-1), '0:00');
});

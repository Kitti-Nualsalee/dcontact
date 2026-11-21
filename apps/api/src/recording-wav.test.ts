import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRecordingSupervisorPlayback } from './recording-playback-config.js';
import { WavFormatError, frameByteRange, parseWavHeader, wavChunk } from './recording-wav.js';

function pcm(frames: number, channels: 1 | 2): Buffer {
  const bytes = Buffer.alloc(frames * channels * 2);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      bytes.writeInt16LE((frame % 1000) + channel, (frame * channels + channel) * 2);
    }
  }
  return bytes;
}

test('a chunk built by the API parses back to the same format and frames', () => {
  const source = wavChunk({ sampleRate: 8000, channels: 2 }, pcm(8000, 2));
  const format = parseWavHeader(source.subarray(0, 4096), source.length);
  assert.deepEqual(format, { dataOffset: 44, sampleRate: 8000, channels: 2, totalFrames: 8000 });
  assert.deepEqual(frameByteRange(format, 100, 50), { start: 444, endInclusive: 643, frames: 50 });
  // ช่วงสุดท้ายถูกตัดตามความยาวไฟล์
  assert.equal(frameByteRange(format, 7990, 16000).frames, 10);
});

test('extra chunks before data and a data size the writer never finalised are tolerated', () => {
  const body = pcm(400, 1);
  const plain = wavChunk({ sampleRate: 16000, channels: 1 }, body);
  const list = Buffer.alloc(8 + 5 + 1);
  list.write('LIST', 0, 'latin1');
  list.writeUInt32LE(5, 4);
  const withList = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
  withList.writeUInt32LE(0, 36 + list.length + 4);
  const format = parseWavHeader(withList, withList.length);
  assert.equal(format.dataOffset, 44 + list.length);
  assert.equal(format.totalFrames, 400);
});

test('formats the player cannot decode are rejected instead of guessed', () => {
  const valid = wavChunk({ sampleRate: 8000, channels: 1 }, pcm(10, 1));
  const mulaw = Buffer.from(valid);
  mulaw.writeUInt16LE(7, 20);
  const eightBit = Buffer.from(valid);
  eightBit.writeUInt16LE(8, 34);
  const sixChannels = Buffer.from(valid);
  sixChannels.writeUInt16LE(6, 22);
  for (const bytes of [
    mulaw,
    eightBit,
    sixChannels,
    Buffer.from('not audio'),
    valid.subarray(0, 30),
  ]) {
    assert.throws(() => parseWavHeader(bytes, bytes.length), WavFormatError);
  }
});

test('the playback switch is off unless explicitly on and rejects misspellings', () => {
  assert.equal(resolveRecordingSupervisorPlayback({}), false);
  assert.equal(resolveRecordingSupervisorPlayback({ RECORDING_SUPERVISOR_PLAYBACK: 'off' }), false);
  assert.equal(resolveRecordingSupervisorPlayback({ RECORDING_SUPERVISOR_PLAYBACK: 'on' }), true);
  assert.throws(() =>
    resolveRecordingSupervisorPlayback({ RECORDING_SUPERVISOR_PLAYBACK: 'true' }),
  );
});

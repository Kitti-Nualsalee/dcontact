import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { observeChildExit, stopChild } from './child-process-lifecycle.mjs';

test('บันทึกผลปิดของ SIPp child ที่จบก่อนขั้นตรวจ media', async () => {
  const child = new EventEmitter();
  const exit = observeChildExit(child);

  child.emit('close', 0);

  assert.equal(await exit, 0);
});

test('ยุติการรอ SIPp child ที่ไม่ปิดภายในเวลาที่กำหนด', async () => {
  const child = new EventEmitter();
  child.kill = (signal) => {
    child.killedWith = signal;
  };

  await assert.rejects(
    observeChildExit(child, { timeoutMs: 5, label: 'SIPp caller' }),
    /SIPp caller ไม่สิ้นสุดภายใน 5ms/,
  );
  assert.equal(child.killedWith, 'SIGTERM');
});

test('cleanup ปิด child streams ก่อนหยุด process เพื่อไม่ให้ acceptance ค้าง', () => {
  const child = new EventEmitter();
  child.stdout = { destroy: () => (child.stdoutDestroyed = true) };
  child.stderr = { destroy: () => (child.stderrDestroyed = true) };
  child.kill = (signal) => {
    child.killedWith = signal;
  };

  stopChild(child);

  assert.deepEqual(
    [child.stdoutDestroyed, child.stderrDestroyed, child.killedWith],
    [true, true, 'SIGTERM'],
  );
});

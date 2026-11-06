import assert from 'node:assert/strict';
import test from 'node:test';
import { ReceiptRecoveryGate } from './customer-360-api.js';

test('DB recovery จำกัด concurrency โดยไม่รอคิว และคืน slot เมื่อสำเร็จหรือล้ม', async () => {
  const gate = new ReceiptRecoveryGate();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const unavailable = () => {
    throw new Error('unavailable');
  };
  const running = Array.from({ length: 4 }, () =>
    gate.run(async () => {
      await hold;
    }, unavailable),
  );
  await assert.rejects(
    gate.run(async () => {}, unavailable),
    /unavailable/,
  );
  release();
  await Promise.all(running);
  await assert.rejects(
    gate.run(async () => {
      throw new Error('db failed');
    }, unavailable),
    /db failed/,
  );
  assert.equal(await gate.run(async () => 'ok', unavailable), 'ok');
});

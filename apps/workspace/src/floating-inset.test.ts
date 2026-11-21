import assert from 'node:assert/strict';
import test from 'node:test';
import { overlapInset } from './floating-inset.js';

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRectReadOnly;

test('dphone ทับมุมล่างของแผง: เว้นที่เท่าส่วนที่ทับบวกช่องว่าง', () => {
  const pane = rect(900, 56, 340, 664);
  assert.equal(overlapInset(pane, rect(940, 480, 320, 220)), 720 - 480 + 8);
});

test('dphone ไม่ทับแผง หรือไม่มี dphone: ไม่เว้นที่', () => {
  const pane = rect(900, 56, 340, 664);
  assert.equal(overlapInset(pane, rect(300, 480, 320, 220)), 0);
  assert.equal(overlapInset(pane, rect(940, 730, 320, 60)), 0);
  assert.equal(overlapInset(pane, undefined), 0);
  assert.equal(overlapInset(pane, rect(940, 480, 0, 0)), 0);
});

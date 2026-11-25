import assert from 'node:assert/strict';
import test from 'node:test';
import { overlapInset } from './floating-inset.js';

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRectReadOnly;

test('dphone overlaps the bottom corner of the panel: leave room equal to the overlap plus a gap', () => {
  const pane = rect(900, 56, 340, 664);
  assert.equal(overlapInset(pane, rect(940, 480, 320, 220)), 720 - 480 + 8);
});

test('dphone does not overlap the panel, or there is no dphone: leave no room', () => {
  const pane = rect(900, 56, 340, 664);
  assert.equal(overlapInset(pane, rect(300, 480, 320, 220)), 0);
  assert.equal(overlapInset(pane, rect(940, 730, 320, 60)), 0);
  assert.equal(overlapInset(pane, undefined), 0);
  assert.equal(overlapInset(pane, rect(940, 480, 0, 0)), 0);
});

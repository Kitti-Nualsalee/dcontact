import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceOutboundGate } from './workspace-governance.js';

function live(sequence: number, payload: Record<string, unknown>) {
  return { type: 'workspace.live', sequence, payload };
}

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

test('CG4.8: relaxation ไม่ปลด outbound gate เอง ต้องยืนยัน canonical version เท่านั้น', () => {
  const gate = new WorkspaceOutboundGate();
  gate.apply(
    live(1, {
      event: 'contact_governance.invalidated',
      aggregateVersion: 4,
      action: 'BLOCK_NEXT_OUTBOUND',
      contractVersion: 1,
      stateDigest: DIGEST_A,
      restrictiveness: 'TIGHTENING',
    }),
  );
  const relaxed = gate.apply(
    live(2, {
      event: 'contact_governance.invalidated',
      aggregateVersion: 5,
      contractVersion: 1,
      stateDigest: DIGEST_B,
      restrictiveness: 'RELAXATION',
    }),
  );
  assert.equal(relaxed?.state, 'BLOCK_NEXT_OUTBOUND');
  assert.equal(gate.snapshot(), 'BLOCK_NEXT_OUTBOUND');
  assert.equal(gate.confirmCanonicalVersion(5)?.state, 'READY');
});

test('CG4.8: version เดียวกันแต่ state digest ต่างทำให้ gate เป็น STALE', () => {
  const gate = new WorkspaceOutboundGate();
  const payload = {
    event: 'contact_governance.invalidated',
    aggregateVersion: 3,
    action: 'BLOCK_NEXT_OUTBOUND',
    contractVersion: 1,
    stateDigest: DIGEST_A,
  };
  gate.apply(live(1, payload));
  assert.equal(gate.apply(live(2, payload)), undefined);
  assert.equal(gate.snapshot(), 'BLOCK_NEXT_OUTBOUND');
  assert.equal(gate.apply(live(3, { ...payload, stateDigest: DIGEST_B }))?.state, 'STALE');
});

test('CG4.8: contract version ที่ไม่รู้จัก fail closed และ relaxation ไม่ล้าง STALE', () => {
  const gate = new WorkspaceOutboundGate();
  const unknown = gate.apply(
    live(1, {
      event: 'contact_governance.invalidated',
      aggregateVersion: 2,
      action: 'BLOCK_NEXT_OUTBOUND',
      contractVersion: 2,
    }),
  );
  assert.equal(unknown?.state, 'STALE');
  gate.apply(
    live(2, {
      event: 'contact_governance.invalidated',
      aggregateVersion: 9,
      contractVersion: 1,
      restrictiveness: 'RELAXATION',
    }),
  );
  assert.equal(gate.snapshot(), 'STALE');
});

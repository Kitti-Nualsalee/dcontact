import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceOutboundGate } from './workspace-governance.js';

test('owner-local governance event บล็อก outbound ถัดไปโดยไม่รับข้อมูลระบุตัวตน', () => {
  const gate = new WorkspaceOutboundGate();
  const alert = gate.apply({
    type: 'workspace.live',
    sequence: 1,
    payload: {
      event: 'contact_governance.invalidated',
      aggregateVersion: 8,
      action: 'BLOCK_NEXT_OUTBOUND',
    },
  });

  assert.equal(alert?.state, 'BLOCK_NEXT_OUTBOUND');
  assert.equal(gate.snapshot(), 'BLOCK_NEXT_OUTBOUND');
});

test('live sequence ที่ขาดหรือ socket หลุดเป็น fail-closed', () => {
  const gate = new WorkspaceOutboundGate();
  gate.apply({ type: 'workspace.live', sequence: 1, payload: { event: 'agent.state_changed' } });
  const alert = gate.apply({
    type: 'workspace.live',
    sequence: 3,
    payload: { event: 'agent.state_changed' },
  });

  assert.equal(alert?.state, 'STALE');
  assert.equal(gate.snapshot(), 'STALE');
  assert.equal(gate.markDisconnected().state, 'STALE');
});

test('เฉพาะ canonical version ที่ไม่เก่าจึงปลด outbound gate ได้', () => {
  const gate = new WorkspaceOutboundGate();
  gate.apply({
    type: 'workspace.live',
    sequence: 1,
    payload: {
      event: 'contact_governance.invalidated',
      aggregateVersion: 8,
      action: 'BLOCK_NEXT_OUTBOUND',
    },
  });

  assert.equal(gate.confirmCanonicalVersion(7), undefined);
  assert.equal(gate.snapshot(), 'BLOCK_NEXT_OUTBOUND');
  assert.equal(gate.confirmCanonicalVersion(8)?.state, 'READY');
});

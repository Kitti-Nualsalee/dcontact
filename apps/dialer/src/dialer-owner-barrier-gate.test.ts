import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DialerGateAuthorizationError,
  DialerGateInvalidTransitionError,
  DialerOwnerBarrierGate,
} from './dialer-owner-barrier-gate.js';

function clock(startMs = 0) {
  let now = startMs;
  return { nowMs: () => now, tick: (ms: number) => (now += ms) };
}

test('gate เริ่มที่ DISABLED และเลื่อนได้ทีละขั้นผ่าน propose/approve', () => {
  const gate = new DialerOwnerBarrierGate(clock());
  const tenant = 'tenant-1';
  assert.equal(gate.currentState(tenant), 'DISABLED');

  gate.propose(tenant, 'TENANT_ADMIN', 'SHADOW_RECEIPT');
  gate.approve(tenant, 'COMPLIANCE');
  assert.equal(gate.currentState(tenant), 'SHADOW_RECEIPT');

  gate.propose(tenant, 'TENANT_ADMIN', 'OWNER_CONFORMANCE');
  gate.approve(tenant, 'COMPLIANCE');
  assert.equal(gate.currentState(tenant), 'OWNER_CONFORMANCE');
});

test('ข้ามขั้นถูกปฏิเสธเป็น DialerGateInvalidTransitionError', () => {
  const gate = new DialerOwnerBarrierGate(clock());
  const tenant = 'tenant-1';
  assert.throws(
    () => gate.propose(tenant, 'TENANT_ADMIN', 'OWNER_CONFORMANCE'),
    DialerGateInvalidTransitionError,
  );
});

test('actor role ที่ไม่ตรงถูกปฏิเสธเป็น DialerGateAuthorizationError', () => {
  const gate = new DialerOwnerBarrierGate(clock());
  const tenant = 'tenant-1';
  assert.throws(
    () => gate.propose(tenant, 'COMPLIANCE', 'SHADOW_RECEIPT'),
    DialerGateAuthorizationError,
  );
  gate.propose(tenant, 'TENANT_ADMIN', 'SHADOW_RECEIPT');
  assert.throws(() => gate.approve(tenant, 'TENANT_ADMIN'), DialerGateAuthorizationError);
});

test('kill ชนะทุก state ทันทีและปฏิเสธ propose ต่อจากนั้น', () => {
  const gate = new DialerOwnerBarrierGate(clock());
  const tenant = 'tenant-1';
  gate.propose(tenant, 'TENANT_ADMIN', 'SHADOW_RECEIPT');
  gate.approve(tenant, 'COMPLIANCE');

  gate.kill(tenant, 'PLATFORM_OPERATOR', 'PROVIDER_TRAFFIC_DETECTED');
  assert.equal(gate.currentState(tenant), 'KILLED');
  assert.equal(gate.killTriggerFor(tenant), 'PROVIDER_TRAFFIC_DETECTED');
  assert.throws(
    () => gate.propose(tenant, 'TENANT_ADMIN', 'OWNER_CONFORMANCE'),
    DialerGateInvalidTransitionError,
  );
});

test('systemKill บันทึก audit เป็น SYSTEM trigger โดยไม่ต้องมี actor สั่ง', () => {
  const gate = new DialerOwnerBarrierGate(clock());
  const tenant = 'tenant-1';
  gate.systemKill(tenant, 'RESERVATION_REUSE');
  assert.equal(gate.currentState(tenant), 'KILLED');
  const lastEntry = gate.audit.at(-1);
  assert.equal(lastEntry?.action, 'KILL');
  assert.equal(lastEntry?.detail, 'SYSTEM:RESERVATION_REUSE');
});

test('tenant คนละใบมี state เป็นอิสระต่อกัน', () => {
  const gate = new DialerOwnerBarrierGate(clock());
  gate.propose('tenant-a', 'TENANT_ADMIN', 'SHADOW_RECEIPT');
  gate.approve('tenant-a', 'COMPLIANCE');
  assert.equal(gate.currentState('tenant-a'), 'SHADOW_RECEIPT');
  assert.equal(gate.currentState('tenant-b'), 'DISABLED');
});

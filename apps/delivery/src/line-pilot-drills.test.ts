import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLineCappedPilotEvidence, type LineReplayProbeEvidence } from './line-pilot-drills.js';

const probe: LineReplayProbeEvidence = {
  status: 'PASS',
  pushStatus: 200,
  replayStatus: 409,
  acceptedRequestId: 'req-1',
  replayAcceptedRequestId: 'req-1',
  sentMessageIds: ['461230966842064897'],
  replaySentMessageIds: ['461230966842064897'],
  acceptedRequestIdMatches: true,
  messageIdsMatch: true,
  evidenceDigest: 'a'.repeat(64),
};
const facts = {
  logicalDeliveries: 1,
  attempts: 1,
  touches: 1,
  refunds: 0,
  acceptedReceipts: 1,
  proposalPresentationDigest: 'b'.repeat(64),
};

test('S2-LINE-PR02 evidence: 200 + 409 เดิม + delivery 1 / Attempt 1 / Touch 1 / refund 0 = PASS', () => {
  const evidence = buildLineCappedPilotEvidence(probe, facts);
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.duplicateObserved, false);
  // evidence ไม่พา request/message ID ดิบของ replay ออกไป — เหลือ digest ของ probe
  assert.equal(evidence.replayEvidenceDigest, probe.evidenceDigest);
});

test('S2-LINE-PR02 evidence: ไม่มี Touch, Touch ซ้ำ, refund, receipt ซ้ำ หรือ probe ล้ม = FAIL', () => {
  for (const [label, override, probeOverride] of [
    ['ยังไม่มี quoted reply', { touches: 0 }, {}],
    ['Touch ซ้ำ', { touches: 2 }, {}],
    ['refund', { refunds: 1 }, {}],
    ['accepted สองครั้ง', { acceptedReceipts: 2 }, {}],
    ['logical delivery สองใบ', { logicalDeliveries: 2 }, {}],
    ['probe ไม่ได้ 409', {}, { status: 'FAIL' as const, replayStatus: 200 }],
    ['ไม่มี proposal digest', { proposalPresentationDigest: 'short' }, {}],
  ] as const) {
    const evidence = buildLineCappedPilotEvidence(
      { ...probe, ...probeOverride },
      { ...facts, ...override },
    );
    assert.equal(evidence.status, 'FAIL', label);
  }
});

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

test('S2-LINE-PR02 evidence: 200 + the original 409 + delivery 1 / Attempt 1 / Touch 1 / refund 0 = PASS', () => {
  const evidence = buildLineCappedPilotEvidence(probe, facts);
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.duplicateObserved, false);
  // the evidence does not carry the raw request/message ID of the replay out — only the probe digest remains
  assert.equal(evidence.replayEvidenceDigest, probe.evidenceDigest);
});

test('S2-LINE-PR02 evidence: no Touch, a duplicate Touch, refund, a duplicate receipt or a failed probe = FAIL', () => {
  for (const [label, override, probeOverride] of [
    ['no quoted reply yet', { touches: 0 }, {}],
    ['duplicate Touch', { touches: 2 }, {}],
    ['refund', { refunds: 1 }, {}],
    ['accepted twice', { acceptedReceipts: 2 }, {}],
    ['two logical deliveries', { logicalDeliveries: 2 }, {}],
    ['probe was not 409', {}, { status: 'FAIL' as const, replayStatus: 200 }],
    ['no proposal digest', { proposalPresentationDigest: 'short' }, {}],
  ] as const) {
    const evidence = buildLineCappedPilotEvidence(
      { ...probe, ...probeOverride },
      { ...facts, ...override },
    );
    assert.equal(evidence.status, 'FAIL', label);
  }
});

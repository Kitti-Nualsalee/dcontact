import assert from 'node:assert/strict';
import test from 'node:test';
import { lineContentDigest } from './line-push-request.js';
import {
  buildLineRunProposalView,
  lineProposalApprovalMatches,
  lineRunProposalEvidence,
  LineRunProposalViewError,
  renderLineRunProposal,
  type LineRunProposalViewInput,
} from './line-run-proposal-view.js';

const CONTENT_REF = 'fixture:service-notification/v1';
const PROPOSED_AT = new Date('2026-09-23T10:00:00.000Z');

function viewInput(overrides: Partial<LineRunProposalViewInput> = {}): LineRunProposalViewInput {
  return {
    finalMainSha: 'c'.repeat(40),
    digests: { config: 'd'.repeat(64), migrations: 'e'.repeat(64), registry: '1'.repeat(64) },
    run: {
      id: '00000000-0000-4000-8000-000000000010',
      tenantId: '00000000-0000-4000-8000-00000000000a',
      proposalDigest: '2'.repeat(64),
      configDigest: 'd'.repeat(64),
      credentialRefId: '00000000-0000-4000-8000-000000000011',
      credentialVersion: 3,
      capLogicalDeliveries: 1,
      capProviderAttempts: 4,
      proposedAt: PROPOSED_AT,
      expiresAt: new Date(PROPOSED_AT.getTime() + 30 * 60_000),
    },
    gate: {
      channelAccountId: '2007056595',
      senderIdentityId: 'sender-approved-test-only',
      purpose: 'SERVICE_NOTIFICATION',
      contactKind: 'SERVICE',
    },
    allowlistEntry: {
      recipientFingerprint: '3'.repeat(64),
      contentRef: CONTENT_REF,
      contentDigest: lineContentDigest(CONTENT_REF),
    },
    credential: {
      fingerprint: '4'.repeat(64),
      expiresAt: new Date('2026-10-10T00:00:00.000Z'),
      credentialKind: 'CHANNEL_ACCESS_TOKEN_V2_1',
    },
    capUsage: { recipientLast24h: 0, last24h: 0, lifetime: 2 },
    quota: { type: 'limited', targetLimit: 200, totalUsage: 5, observedAt: PROPOSED_AT },
    retryKey: '5f0c7a6e-1b2d-4c3e-8f40-123456789abc',
    ...overrides,
  };
}

test('S2-LINE-AU01: proposal view แสดงทุกค่าที่ต้องอนุมัติและผูกด้วย digest เดียว', () => {
  const view = buildLineRunProposalView(viewInput());
  assert.equal(view.fixture.contentDigest, lineContentDigest(CONTENT_REF));
  assert.ok(view.fixture.text[0]!.length > 0);
  assert.equal(view.recipientFingerprint, '3'.repeat(64));
  assert.deepEqual(view.caps.lifetime, { used: 2, max: 10 });
  assert.match(view.presentationDigest, /^[0-9a-f]{64}$/);
  assert.equal(buildLineRunProposalView(viewInput()).presentationDigest, view.presentationDigest);
  const text = renderLineRunProposal(view);
  for (const expected of [
    view.presentationDigest,
    view.recipientFingerprint,
    view.finalMainSha,
    view.retryKey,
    view.fixture.text[0]!,
  ])
    assert.ok(text.includes(expected), expected);
});

test('S2-LINE-AU01: ค่าใดเปลี่ยน digest เปลี่ยน และอนุมัติได้เฉพาะ digest ตรงทุกตัวอักษร', () => {
  const view = buildLineRunProposalView(viewInput());
  const changed = buildLineRunProposalView(
    viewInput({ retryKey: '5f0c7a6e-1b2d-4c3e-8f40-123456789abd' }),
  );
  assert.notEqual(changed.presentationDigest, view.presentationDigest);
  assert.equal(lineProposalApprovalMatches(view, view.presentationDigest), true);
  assert.equal(lineProposalApprovalMatches(view, view.presentationDigest.slice(0, 12)), false);
  assert.equal(lineProposalApprovalMatches(view, view.presentationDigest.toUpperCase()), false);
  const edited = { ...view, recipientFingerprint: '9'.repeat(64) };
  assert.equal(lineProposalApprovalMatches(edited, view.presentationDigest), false);
});

test('S2-LINE-OB02: evidence ของ proposal ไม่มีข้อความ fixture และ Channel ID ดิบ', () => {
  const view = buildLineRunProposalView(viewInput());
  const evidence = lineRunProposalEvidence(view);
  const serialized = JSON.stringify(evidence);
  assert.ok(!serialized.includes(view.fixture.text[0]!));
  assert.ok(!serialized.includes('2007056595'));
  assert.equal(evidence.presentationDigest, view.presentationDigest);
  assert.match(evidence.channelAccountFingerprint, /^[0-9a-f]{64}$/);
});

test('S2-LINE-AU01: content/config digest ไม่ตรง, TTL เกิน, cap เต็ม หรือ retry key ผิดรูป = ไม่แสดง', () => {
  const code = (input: LineRunProposalViewInput) => {
    try {
      buildLineRunProposalView(input);
      return 'OK';
    } catch (error) {
      return (error as LineRunProposalViewError).code;
    }
  };
  const base = viewInput();
  assert.equal(
    code({ ...base, allowlistEntry: { ...base.allowlistEntry, contentDigest: 'f'.repeat(64) } }),
    'CONTENT_DIGEST_MISMATCH',
  );
  assert.equal(
    code({ ...base, digests: { ...base.digests, config: '0'.repeat(64) } }),
    'CONFIG_DIGEST_MISMATCH',
  );
  assert.equal(
    code({
      ...base,
      run: { ...base.run, expiresAt: new Date(PROPOSED_AT.getTime() + 31 * 60_000) },
    }),
    'PROPOSAL_TTL_INVALID',
  );
  assert.equal(
    code({ ...base, capUsage: { recipientLast24h: 1, last24h: 1, lifetime: 1 } }),
    'CAP_SNAPSHOT_EXCEEDED',
  );
  assert.equal(
    code({ ...base, capUsage: { recipientLast24h: 0, last24h: 0, lifetime: 10 } }),
    'CAP_SNAPSHOT_EXCEEDED',
  );
  assert.equal(code({ ...base, retryKey: 'NOT-A-UUID' }), 'RETRY_KEY_INVALID');
  assert.equal(code({ ...base, finalMainSha: 'main' }), 'FINAL_MAIN_SHA_INVALID');
});

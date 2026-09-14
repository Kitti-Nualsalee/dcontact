import type { Prisma } from '@d-contact/db';
import {
  CG4_EVALUATOR_VERSION,
  CG4_EVENT_TYPES,
  CG4_POLICY_SCHEMA_VERSION,
  CG4_RULE_REGISTRY_VERSION,
  type Cg4TransitionKind,
} from '@d-contact/cxa-contracts';
import { stableDigest } from './cg3-persistence.js';
import { cg4EventScopeDimensions } from './cg4-policy-compiler.js';

/**
 * Canonical `governance.kill-switch.changed` event ของ kill switch หนึ่งตัว ใช้ร่วมกันระหว่าง
 * คำสั่งของ operator (CG4.5) และ backfill ของ CG4.10 เพื่อให้ consumer ได้ event รูปเดียวกันเสมอ
 *
 * kill switch หนึ่งตัวมี lifecycle บน aggregate ของตัวเอง ACTIVE(1) → CLEARED(2) (#228): version
 * คงที่จะทำให้ CLEAR ถูกทุก consumer quarantine เป็น hash conflict
 */
export interface Cg4KillSwitchEventInput {
  tenantId: string;
  scopeKey: string;
  killSwitchId: string;
  state: 'ACTIVE' | 'CLEARED';
  mutationId: string;
  eventId: string;
  occurredAt: Date;
}

export interface Cg4KillSwitchEventRecord {
  version: 1 | 2;
  stateDigest: string;
  outbox: Prisma.CgEventOutboxUncheckedCreateInput;
}

export function cg4KillSwitchEvent(input: Cg4KillSwitchEventInput): Cg4KillSwitchEventRecord {
  const version = input.state === 'ACTIVE' ? 1 : 2;
  const stateDigest = stableDigest({
    scopeKey: input.scopeKey,
    state: input.state,
    killSwitchId: input.killSwitchId,
  });
  const payload = {
    contractVersion: 1,
    mutationId: input.mutationId,
    transitionKind: (input.state === 'ACTIVE'
      ? 'KILL_SWITCH_ACTIVATED'
      : 'KILL_SWITCH_CLEARED') as Cg4TransitionKind,
    subjectId: input.killSwitchId,
    subjectVersion: version,
    state: input.state,
    effectiveAt: input.occurredAt.toISOString(),
    affectedScope: { scopeKey: input.scopeKey, ...cg4EventScopeDimensions(input.scopeKey) },
    scopeDigest: stableDigest({ scopeKey: input.scopeKey }),
    ruleRegistryVersion: CG4_RULE_REGISTRY_VERSION,
    policySchemaVersion: CG4_POLICY_SCHEMA_VERSION,
    evaluatorVersion: CG4_EVALUATOR_VERSION,
    stateDigest,
    restrictiveness: input.state === 'ACTIVE' ? 'TIGHTENING' : 'RELAXATION',
  };
  return {
    version,
    stateDigest,
    outbox: {
      id: input.eventId,
      mutationId: input.mutationId,
      tenantId: input.tenantId,
      aggregateType: 'POLICY',
      aggregateId: input.killSwitchId,
      aggregateVersion: version,
      eventType: CG4_EVENT_TYPES.KILL_SWITCH_CHANGED,
      orderingKey: `${input.tenantId}:${input.scopeKey}`,
      payload: payload as unknown as Prisma.InputJsonValue,
      payloadHash: stableDigest(payload),
    },
  };
}

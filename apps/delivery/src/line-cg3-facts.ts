/**
 * Owner: Delivery/Channels — mutable CG3 fact registry of the LINE simulation (S1.6)
 *
 * Wraps `evaluateCg3Policy` (a pure function of Contact Governance, #106) with facts that a
 * test can change during a scenario to simulate realtime opt-out/quiet-hours mid-flight,
 * without touching the database or importing a Contact Governance service directly — it calls only the
 * evaluator that is a pure function, per the cross-domain contract of #98.
 */
import {
  evaluateCg3Policy,
  type Cg3CallbackFacts,
  type Cg3GateOutcome,
  type Cg3PolicyFacts,
  type Cg3PreferenceCandidate,
} from '@d-contact/contact-governance';
import { LINE_CHANNEL, LINE_CONTACT_KIND, LINE_PURPOSE } from './line-simulation-fixture.js';

export interface LineCg3ScopeFacts {
  identityId?: string;
  senderIdentityId: string;
  customerExplicitTimezone?: string | null;
  customer360Timezone?: string | null;
  tenantDefaultTimezone?: string | null;
  preferences: Cg3PreferenceCandidate[];
  policy?: Cg3PolicyFacts;
  activeCallback?: Cg3CallbackFacts;
}

/**
 * The key is (tenantId, identityId) only — the S1.6 pilot binds one contact per identity
 * in every scenario per #100 (no multiple identities per pilot tenant)
 */
export class LineCg3FactsRegistry {
  private readonly facts = new Map<string, LineCg3ScopeFacts>();

  private key(tenantId: string, identityId: string | undefined): string {
    return JSON.stringify([tenantId, identityId ?? null]);
  }

  set(tenantId: string, facts: LineCg3ScopeFacts): void {
    this.facts.set(this.key(tenantId, facts.identityId), structuredClone(facts));
  }

  /** Used to simulate a realtime opt-out/quiet-hours transition while a job is still queued/claimed */
  mutate(
    tenantId: string,
    identityId: string | undefined,
    patch: Partial<LineCg3ScopeFacts>,
  ): void {
    const key = this.key(tenantId, identityId);
    const current = this.facts.get(key);
    if (!current) throw new Error(`no CG3 facts for this tenant/identity: ${key}`);
    this.facts.set(key, { ...current, ...structuredClone(patch) });
  }

  evaluate(tenantId: string, identityId: string | undefined, now: Date): Cg3GateOutcome {
    const facts = this.facts.get(this.key(tenantId, identityId));
    if (!facts)
      throw new Error(`no CG3 facts for this tenant/identity: ${this.key(tenantId, identityId)}`);
    return evaluateCg3Policy({
      now,
      identityId: facts.identityId,
      channel: LINE_CHANNEL,
      purpose: LINE_PURPOSE,
      contactKind: LINE_CONTACT_KIND,
      senderIdentityId: facts.senderIdentityId,
      customerExplicitTimezone: facts.customerExplicitTimezone,
      customer360Timezone: facts.customer360Timezone,
      tenantDefaultTimezone: facts.tenantDefaultTimezone,
      preferences: facts.preferences,
      policy: facts.policy,
      activeCallback: facts.activeCallback,
    });
  }
}

/** Starting fixture: no preference/policy/callback at all, passes every gate as ALLOW always */
export function allowAllFacts(senderIdentityId: string, identityId?: string): LineCg3ScopeFacts {
  return { identityId, senderIdentityId, preferences: [] };
}

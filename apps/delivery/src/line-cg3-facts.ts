/**
 * Owner: Delivery/Channels — mutable CG3 fact registry ของ LINE simulation (S1.6)
 *
 * ห่อ `evaluateCg3Policy` (pure function ของ Contact Governance, #106) ด้วย facts ที่
 * test เปลี่ยนได้ระหว่าง scenario เพื่อจำลอง realtime opt-out/quiet-hours mid-flight
 * โดยไม่แตะ database หรือ import service ของ Contact Governance โดยตรง — เรียกเฉพาะ
 * evaluator ที่เป็น pure function ตามสัญญาข้าม domain ของ #98
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
 * key เป็น (tenantId, identityId) เท่านั้น — S1.6 pilot ผูก contact เดียวต่อ identity
 * ในทุก scenario ตาม #100 (ไม่มีหลาย identity ต่อ pilot tenant)
 */
export class LineCg3FactsRegistry {
  private readonly facts = new Map<string, LineCg3ScopeFacts>();

  private key(tenantId: string, identityId: string | undefined): string {
    return JSON.stringify([tenantId, identityId ?? null]);
  }

  set(tenantId: string, facts: LineCg3ScopeFacts): void {
    this.facts.set(this.key(tenantId, facts.identityId), structuredClone(facts));
  }

  /** ใช้จำลอง realtime opt-out/quiet-hours transition ระหว่างงานยัง queued/claimed */
  mutate(
    tenantId: string,
    identityId: string | undefined,
    patch: Partial<LineCg3ScopeFacts>,
  ): void {
    const key = this.key(tenantId, identityId);
    const current = this.facts.get(key);
    if (!current) throw new Error(`ไม่มี CG3 facts ของ tenant/identity นี้: ${key}`);
    this.facts.set(key, { ...current, ...structuredClone(patch) });
  }

  evaluate(tenantId: string, identityId: string | undefined, now: Date): Cg3GateOutcome {
    const facts = this.facts.get(this.key(tenantId, identityId));
    if (!facts)
      throw new Error(`ไม่มี CG3 facts ของ tenant/identity นี้: ${this.key(tenantId, identityId)}`);
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

/** fixture เริ่มต้น: ไม่มี preference/policy/callback ใด ๆ ผ่านทุก gate เป็น ALLOW เสมอ */
export function allowAllFacts(senderIdentityId: string, identityId?: string): LineCg3ScopeFacts {
  return { identityId, senderIdentityId, preferences: [] };
}

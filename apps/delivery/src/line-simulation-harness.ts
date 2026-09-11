/**
 * Owner: Delivery/Channels — shared test harness ของ LINE simulation (S1.6)
 *
 * ไม่ใช่ test ไฟล์เอง (ไม่ตรง `*.test.ts`/`*.integration.ts`) — เป็น scaffolding ที่
 * ทุก scenario เรียกใช้ร่วมกัน คล้าย `delivery-fixture.ts` ของ C1.3 แต่ไม่แตะ Postgres
 */
import {
  actionKey,
  contactId as toContactId,
  identityId as toIdentityId,
  reservationId as toReservationId,
  tenantId as toTenantId,
  type AuthorizeAndReserveInput,
  type EnqueueDeliveryCommand,
} from '@d-contact/cxa-contracts';
import { ContactGovernanceFake } from '@d-contact/cxa-contracts/testing/contact-governance-fake.js';
import { LineCapsTracker } from './line-caps-tracker.js';
import { LineCg3FactsRegistry, allowAllFacts } from './line-cg3-facts.js';
import { LineDeliveryPort } from './line-delivery-port.js';
import { LineSimulationStore } from './line-delivery-store.js';
import { ManualClock } from './line-manual-clock.js';
import { LineRolloutGate } from './line-rollout-gate.js';
import {
  LINE_CHANNEL,
  LINE_CONTACT_KIND,
  LINE_PURPOSE,
  PILOT_SCOPE,
  PILOT_SENDER_IDENTITY_ID,
  PILOT_TENANT_ID,
  type LineScopeTuple,
} from './line-simulation-fixture.js';

export const SIMULATION_START_AT = '2026-09-10T09:00:00.000Z';
export const RESERVATION_EXPIRY = '2026-09-10T09:15:00.000Z';
export const LEASE_EXPIRY = '2026-09-10T09:10:00.000Z';

export interface MakeCommandOptions {
  tenantId?: string;
  actionKey?: string;
  reservationId?: string;
  contactId?: string;
  identityId?: string;
  senderIdentityId?: string;
  contentRef?: string;
}

export class LineSimulationHarness {
  readonly clock: ManualClock;
  readonly gate: LineRolloutGate;
  readonly caps: LineCapsTracker;
  readonly store: LineSimulationStore;
  readonly governance: ContactGovernanceFake;
  readonly port: LineDeliveryPort;
  readonly cg3: LineCg3FactsRegistry;

  constructor() {
    this.clock = new ManualClock(SIMULATION_START_AT);
    this.gate = new LineRolloutGate(this.clock);
    this.caps = new LineCapsTracker();
    this.store = new LineSimulationStore();
    this.governance = new ContactGovernanceFake(() => this.clock.nowMs());
    this.cg3 = new LineCg3FactsRegistry();
    this.port = this.buildPort();
  }

  private buildPort(): LineDeliveryPort {
    return new LineDeliveryPort({
      clock: this.clock,
      governance: this.governance,
      rolloutGate: this.gate,
      caps: this.caps,
      store: this.store,
    });
  }

  /** จำลอง process restart: instance ใหม่ผูกกับ store/gate/caps/governance เดิมทั้งหมด */
  restartPort(): LineDeliveryPort {
    return this.buildPort();
  }

  seedAndBuildCommand(options: MakeCommandOptions = {}): EnqueueDeliveryCommand {
    const tenant = options.tenantId ?? PILOT_TENANT_ID;
    const action = options.actionKey ?? `line-action-${Math.random().toString(36).slice(2, 10)}`;
    const reservation = options.reservationId ?? `line-reservation-${action}`;
    const contact = options.contactId ?? 'line-contact-a';
    const identity = options.identityId ?? 'line-identity-a';
    const sender = options.senderIdentityId ?? PILOT_SENDER_IDENTITY_ID;

    const authorization: AuthorizeAndReserveInput = {
      actionKey: actionKey(action),
      channel: LINE_CHANNEL,
      purpose: LINE_PURPOSE,
      contactKind: LINE_CONTACT_KIND,
      source: 'JOURNEY',
      sourceId: 'journey-line-pilot',
      contactId: toContactId(contact),
      identityId: toIdentityId(identity),
      policyVersion: 1,
      senderIdentityId: sender,
    };
    this.governance.seed(
      toTenantId(tenant),
      authorization,
      {
        decision: 'ALLOW',
        decisionId: `decision-${action}`,
        reasonCode: 'POLICY_PASSED',
        policyVersion: 1,
        trace: [],
        reservationId: reservation,
        reservationExpiresAt: RESERVATION_EXPIRY,
      },
      true,
      sender,
    );

    this.cg3.set(tenant, allowAllFacts(sender, identity));

    return {
      tenantId: toTenantId(tenant),
      source: 'JOURNEY',
      actionKey: actionKey(action),
      reservationId: toReservationId(reservation),
      channel: LINE_CHANNEL,
      contactId: toContactId(contact),
      identityId: toIdentityId(identity),
      contentRef: options.contentRef ?? 'line-content-ref-a',
      correlationId: `corr-${action}`,
      purpose: LINE_PURPOSE,
      senderIdentityId: sender,
      leaseExpiresAt: LEASE_EXPIRY,
    };
  }

  /** เลื่อน pilot scope ให้ครบ DISABLED -> DRY_RUN -> SIMULATED_CAPPED_PILOT ผ่าน maker-checker + switch */
  openPilotTo(
    target: 'DRY_RUN' | 'SIMULATED_CAPPED_PILOT',
    scope: LineScopeTuple = PILOT_SCOPE,
  ): void {
    this.gate.setTechnicalSwitch(scope, 'PLATFORM_OPERATOR', true);
    this.gate.propose(scope, 'TENANT_ADMIN', 'DRY_RUN');
    this.gate.approve(scope, 'COMPLIANCE');
    if (target === 'SIMULATED_CAPPED_PILOT') {
      this.gate.propose(scope, 'TENANT_ADMIN', 'SIMULATED_CAPPED_PILOT');
      this.gate.approve(scope, 'COMPLIANCE');
    }
  }
}

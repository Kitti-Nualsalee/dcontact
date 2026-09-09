/** E0 test fake เท่านั้น: ไม่มี persistence, provider I/O หรือ canonical Attempt/Touch */
import {
  type AuthorizeAndReserveInput,
  type AuthorizationOutcome,
  type BeginProviderSubmissionInput,
  type RenewReservationLeaseInput,
  type ClaimReservationForDeliveryInput,
  type ConfirmProviderAcceptanceInput,
  type ContactGovernancePort,
  type ReleaseBeforeSubmitInput,
  type ReservationDeliveryCommand,
  type ReservationSettlementView,
  type SettleDeliveryInput,
  ReservationBindingError,
} from '../contact-governance.js';
import { actionKey, reservationId, type TenantId } from '../identifiers.js';

interface Fixture {
  tenantId: TenantId;
  input: AuthorizeAndReserveInput;
  outcome: AuthorizationOutcome;
  view: ReservationSettlementView;
  claim?: ClaimReservationForDeliveryInput;
  providerRequestKey?: string;
  terminal: boolean;
  /** Fixture policy ของ Governance; adapter เปลี่ยนค่าเองไม่ได้ */
  refundOnFailure: boolean;
  senderIdentityId: string;
}

function canonical(value: object): string {
  return JSON.stringify(
    Object.entries(value)
      .filter(([key, v]) => key !== 'correlationId' && v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export class ContactGovernanceFake implements ContactGovernancePort {
  private readonly fixtures = new Map<string, Fixture>();
  private readonly responses = new Map<
    string,
    { input: string; view: ReservationSettlementView }
  >();
  private readonly outcomes = new Map<string, string>();

  constructor(private readonly now: () => number) {}

  /** Seed เป็น policy decision ที่ test ยืนยันแล้ว ไม่ใช่ policy evaluator */
  seed(
    tenantId: TenantId,
    input: AuthorizeAndReserveInput,
    outcome: AuthorizationOutcome,
    refundOnFailure = true,
    senderIdentityId = 'sender-a',
  ): void {
    if (!outcome.reservationId || !outcome.reservationExpiresAt || outcome.decision !== 'ALLOW') {
      throw new Error('fixture ต้องเป็น ALLOW พร้อม reservation และ expiry');
    }
    this.fixtures.set(JSON.stringify([tenantId, outcome.reservationId]), {
      tenantId,
      input: structuredClone(input),
      outcome: structuredClone(outcome),
      refundOnFailure,
      senderIdentityId,
      terminal: false,
      view: {
        reservationId: reservationId(outcome.reservationId),
        actionKey: actionKey(input.actionKey),
        state: 'RESERVED',
        status: 'UNCLAIMED',
      },
    });
  }

  async authorizeAndReserve(
    tenantId: TenantId,
    input: AuthorizeAndReserveInput & { correlationId: string },
  ): Promise<AuthorizationOutcome> {
    const fixture = [...this.fixtures.values()].find(
      (f) => f.tenantId === tenantId && f.input.actionKey === input.actionKey,
    );
    if (!fixture) throw new ReservationBindingError('RESERVATION_NOT_FOUND');
    if (canonical(fixture.input) !== canonical(input))
      throw new ReservationBindingError('IDEMPOTENCY_CONFLICT');
    return structuredClone(fixture.outcome);
  }

  private find(input: ReservationDeliveryCommand): Fixture {
    const fixture = this.fixtures.get(JSON.stringify([input.tenantId, input.reservationId]));
    if (!fixture) throw new ReservationBindingError('RESERVATION_NOT_FOUND');
    if (fixture.input.actionKey !== input.actionKey)
      throw new ReservationBindingError('RESERVATION_BINDING_CONFLICT');
    return fixture;
  }

  private bound(f: Fixture, deliveryId: string | undefined): void {
    if (!f.claim || f.claim.deliveryId !== deliveryId)
      throw new ReservationBindingError('RESERVATION_BINDING_CONFLICT');
  }

  private provider(f: Fixture, key: string): void {
    if (f.providerRequestKey && f.providerRequestKey !== key)
      throw new ReservationBindingError('RESERVATION_BINDING_CONFLICT');
  }

  private once(
    operation: string,
    input: ReservationDeliveryCommand,
    apply: (f: Fixture) => void,
  ): ReservationSettlementView {
    const f = this.find(input);
    const key = JSON.stringify([input.tenantId, input.reservationId, operation]);
    const hash = canonical(input);
    const previous = this.responses.get(key);
    if (previous) {
      if (previous.input !== hash) throw new ReservationBindingError('IDEMPOTENCY_CONFLICT');
      return structuredClone(previous.view);
    }
    apply(f);
    const view = structuredClone(f.view);
    this.responses.set(key, { input: hash, view });
    return structuredClone(view);
  }

  async claimReservationForDelivery(
    input: ClaimReservationForDeliveryInput,
  ): Promise<ReservationSettlementView> {
    return this.once('claim', input, (f) => {
      if (f.view.state !== 'RESERVED')
        throw new ReservationBindingError('RESERVATION_NOT_RESERVED');
      const expiry = Date.parse(f.outcome.reservationExpiresAt!);
      if (expiry <= this.now()) throw new ReservationBindingError('RESERVATION_EXPIRED');
      const lease = Date.parse(input.leaseExpiresAt);
      if (!Number.isFinite(lease) || lease <= this.now() || lease > expiry)
        throw new ReservationBindingError('INVALID_RESERVATION_LEASE');
      if (
        f.input.contactId !== input.contactId ||
        f.input.identityId !== input.identityId ||
        f.input.channel !== input.channel ||
        f.input.purpose !== input.purpose ||
        f.senderIdentityId !== input.senderIdentityId
      ) {
        throw new ReservationBindingError('RESERVATION_BINDING_CONFLICT');
      }
      f.claim = structuredClone(input);
      f.view.deliveryId = input.deliveryId;
      f.view.status = 'CLAIMED';
      f.view.leaseVersion = 1;
      f.view.leaseExpiresAt = input.leaseExpiresAt;
    });
  }

  private activeLease(f: Fixture, expectedVersion: number): void {
    if (f.terminal || f.view.state !== 'RESERVED')
      throw new ReservationBindingError('INVALID_RESERVATION_TRANSITION');
    if (f.providerRequestKey) throw new ReservationBindingError('DELIVERY_RECONCILIATION_REQUIRED');
    if (
      !Number.isInteger(expectedVersion) ||
      expectedVersion < 1 ||
      f.view.leaseVersion !== expectedVersion
    )
      throw new ReservationBindingError('STALE_RESERVATION_LEASE');
    if (!f.view.leaseExpiresAt || Date.parse(f.view.leaseExpiresAt) <= this.now())
      throw new ReservationBindingError('RESERVATION_EXPIRED');
  }

  async renewReservationLease(
    input: RenewReservationLeaseInput,
  ): Promise<ReservationSettlementView> {
    return this.once(`renew:${input.expectedLeaseVersion}`, input, (f) => {
      this.bound(f, input.deliveryId);
      this.activeLease(f, input.expectedLeaseVersion);
      const expiry = Date.parse(input.leaseExpiresAt);
      if (
        !Number.isFinite(expiry) ||
        expiry <= Date.parse(f.view.leaseExpiresAt!) ||
        expiry > Date.parse(f.outcome.reservationExpiresAt!)
      )
        throw new ReservationBindingError('INVALID_RESERVATION_LEASE');
      f.view.leaseExpiresAt = input.leaseExpiresAt;
      f.view.leaseVersion = input.expectedLeaseVersion + 1;
    });
  }

  async beginProviderSubmission(
    input: BeginProviderSubmissionInput,
  ): Promise<ReservationSettlementView> {
    return this.once('begin', input, (f) => {
      this.bound(f, input.deliveryId);
      this.activeLease(f, input.expectedLeaseVersion);
      // จำลอง atomic barrier ก่อน I/O เท่านั้น; production persistence เป็นงาน CG2
      f.providerRequestKey = input.providerRequestKey;
      f.view.status = 'UNKNOWN_RECONCILING';
    });
  }

  private submission(f: Fixture, key: string): void {
    if (!f.providerRequestKey) throw new ReservationBindingError('INVALID_RESERVATION_TRANSITION');
    this.provider(f, key);
  }

  async confirmProviderAcceptance(
    input: ConfirmProviderAcceptanceInput,
  ): Promise<ReservationSettlementView> {
    return this.once('confirm', input, (f) => {
      this.bound(f, input.deliveryId);
      this.submission(f, input.providerRequestKey);
      if (f.terminal) throw new ReservationBindingError('INVALID_RESERVATION_TRANSITION');
      f.providerRequestKey = input.providerRequestKey;
      f.view.state = 'CONFIRMED';
      f.view.status = 'ACCEPTED';
    });
  }

  async releaseBeforeSubmit(input: ReleaseBeforeSubmitInput): Promise<ReservationSettlementView> {
    return this.once('release', input, (f) => {
      if (f.claim || input.deliveryId) this.bound(f, input.deliveryId);
      if (f.view.status === 'UNKNOWN_RECONCILING')
        throw new ReservationBindingError('DELIVERY_RECONCILIATION_REQUIRED');
      if (f.view.state !== 'RESERVED' || f.terminal || f.providerRequestKey)
        throw new ReservationBindingError('INVALID_RESERVATION_TRANSITION');
      const expiry = Date.parse(f.view.leaseExpiresAt ?? f.outcome.reservationExpiresAt!);
      if (input.reason === 'LEASE_EXPIRED' && expiry > this.now())
        throw new ReservationBindingError('INVALID_RESERVATION_LEASE');
      f.view.state = 'RELEASED';
      f.view.status = 'SETTLED';
      f.terminal = true;
    });
  }

  async settleDelivery(input: SettleDeliveryInput): Promise<ReservationSettlementView> {
    // outcomeRef กันการนำ callback เดิมไปผูกกับ action อื่นใน tenant เดียวกัน
    const outcomeKey = JSON.stringify([input.tenantId, input.outcomeRef]);
    const previous = this.outcomes.get(outcomeKey);
    if (previous && previous !== canonical(input))
      throw new ReservationBindingError('IDEMPOTENCY_CONFLICT');
    const result = this.once(`settle:${input.outcomeRef}`, input, (f) => {
      this.bound(f, input.deliveryId);
      this.submission(f, input.providerRequestKey);
      if (f.terminal) return;
      if (input.outcome === 'PROVIDER_REJECTED' && f.view.state === 'CONFIRMED')
        throw new ReservationBindingError('INVALID_RESERVATION_TRANSITION');
      if (input.outcome === 'DELIVERY_FAILED' && f.view.state !== 'CONFIRMED')
        throw new ReservationBindingError('DELIVERY_RECONCILIATION_REQUIRED');
      f.providerRequestKey = input.providerRequestKey;
      if (input.outcome === 'UNKNOWN_RECONCILING') {
        if (f.view.status !== 'ACCEPTED') f.view.status = 'UNKNOWN_RECONCILING';
        return;
      }
      f.view.state =
        input.outcome === 'PROVIDER_REJECTED'
          ? 'RELEASED'
          : input.outcome === 'DELIVERY_FAILED' && f.refundOnFailure
            ? 'REFUNDED'
            : 'CONFIRMED';
      f.view.status = 'SETTLED';
      f.terminal = true;
    });
    this.outcomes.set(outcomeKey, canonical(input));
    return result;
  }
}

/**
 * DeliveryTestAdapter must pass the same #67 conformance suite that the E0 fake passes.
 *
 * The suite's `makeHarness` is synchronous, but a real harness must first create the tenant/reservation
 * in the database, so harnesses are prepared up front as a pool and handed out one at a time: one test,
 * one tenant, so the cases do not contaminate each other.
 */
import { after } from 'node:test';
import { actionKey } from '@d-contact/cxa-contracts';
import { runDeliveryPortConformanceSuite } from '@d-contact/cxa-contracts/testing/delivery-conformance.js';
import { createDeliveryFixture, type DeliveryFixture } from './delivery-fixture.js';

/** The #67 suite has 8 cases and calls makeHarness once per case */
const HARNESS_COUNT = 8;

const pool: DeliveryFixture[] = [];
for (let index = 0; index < HARNESS_COUNT; index += 1) {
  pool.push(await createDeliveryFixture());
}

after(async () => {
  await Promise.all(pool.map((fixture) => fixture.dispose()));
});

let next = 0;

runDeliveryPortConformanceSuite('DeliveryTestAdapter', () => {
  const fixture = pool[next];
  next += 1;
  if (!fixture) {
    throw new Error(
      `conformance suite asked for more than the ${HARNESS_COUNT} prepared harnesses`,
    );
  }
  return {
    delivery: fixture.delivery,
    command: fixture.command,
    unknownReservationId: fixture.command.reservationId.replace(
      /^.{8}/,
      '00000000',
    ) as typeof fixture.command.reservationId,
    mismatchedActionKey: actionKey(`${fixture.command.actionKey}-mismatch`),
    otherTenantId: fixture.otherTenantId,
    advance: fixture.advance,
  };
});

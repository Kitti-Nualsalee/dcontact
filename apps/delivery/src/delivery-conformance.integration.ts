/**
 * DeliveryTestAdapter ต้องผ่าน conformance suite ของ #67 ตัวเดียวกับที่ E0 fake ผ่าน
 *
 * `makeHarness` ของ suite เป็น synchronous แต่ harness จริงต้องสร้าง tenant/reservation
 * ในฐานข้อมูลก่อน จึงเตรียม harness ไว้ล่วงหน้าเป็น pool แล้วแจกทีละใบ — หนึ่ง test
 * หนึ่ง tenant เพื่อให้ผลของแต่ละเคสไม่ปนกัน
 */
import { after } from 'node:test';
import { actionKey } from '@d-contact/cxa-contracts';
import { runDeliveryPortConformanceSuite } from '@d-contact/cxa-contracts/testing/delivery-conformance.js';
import { createDeliveryFixture, type DeliveryFixture } from './delivery-fixture.js';

/** suite ของ #67 มี 8 เคส และเรียก makeHarness เคสละครั้ง */
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
    throw new Error(`conformance suite ขอ harness เกิน ${HARNESS_COUNT} ใบที่เตรียมไว้`);
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

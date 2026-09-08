import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionKey,
  contactId,
  deliveryId,
  identityId,
  outcomeRef,
  providerRequestKey,
  reservationId,
  segmentId,
  teamId,
  tenantId,
} from './identifiers.js';

test('stable identifiers preserve their string JSON boundary', () => {
  const identifiers = {
    tenantId: tenantId('tenant-a'),
    contactId: contactId('contact-a'),
    identityId: identityId('identity-a'),
    teamId: teamId('team-a'),
    segmentId: segmentId('LOND'),
    actionKey: actionKey('enrollment-1:3:send-reminder'),
    reservationId: reservationId('reservation-a'),
    deliveryId: deliveryId('delivery-a'),
    providerRequestKey: providerRequestKey('provider-request-a'),
    outcomeRef: outcomeRef('provider:outcome-a'),
  };

  assert.deepEqual(JSON.parse(JSON.stringify(identifiers)), identifiers);
});

test('stable identifiers reject empty values', () => {
  assert.throws(() => actionKey('   '), /ActionKey ต้องเป็น string ที่ไม่ว่าง/);
  assert.throws(() => tenantId(''), /TenantId ต้องเป็น string ที่ไม่ว่าง/);
});

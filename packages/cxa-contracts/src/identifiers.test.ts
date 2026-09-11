import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionKey,
  callbackId,
  campaignId,
  caseId,
  commandId,
  contactId,
  deliveryId,
  enrollmentId,
  identityId,
  interactionId,
  journeyId,
  outcomeId,
  outcomeRef,
  providerRequestKey,
  recordId,
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
    interactionId: interactionId('interaction-a'),
    outcomeId: outcomeId('outcome-a'),
    commandId: commandId('command-a'),
    journeyId: journeyId('journey-a'),
    enrollmentId: enrollmentId('enrollment-a'),
    caseId: caseId('case-a'),
    campaignId: campaignId('campaign-a'),
    recordId: recordId('record-a'),
    callbackId: callbackId('callback-a'),
  };

  assert.deepEqual(JSON.parse(JSON.stringify(identifiers)), identifiers);
});

test('stable identifiers reject empty values', () => {
  assert.throws(() => actionKey('   '), /ActionKey ต้องเป็น string ที่ไม่ว่าง/);
  assert.throws(() => tenantId(''), /TenantId ต้องเป็น string ที่ไม่ว่าง/);
});

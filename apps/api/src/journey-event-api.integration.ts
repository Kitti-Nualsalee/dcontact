import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import { EventInboxService } from '@d-contact/journey';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
} from './gateway-auth.js';
import { JOURNEY_EVENT_INBOX, JourneyEventController } from './journey-event-api.js';

test('event ingress ใช้ tenant จาก client credentials และบังคับ idempotency', async (t) => {
  const owner = new PrismaClient();
  const application = new PrismaClient({
    datasources: {
      db: {
        url:
          process.env.APPLICATION_DATABASE_URL ??
          'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
      },
    },
  });
  const tenantId = randomUUID();
  const userId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Journey API ${tenantId}`,
      slug: `journey-api-${tenantId}`,
      sipDomain: `${tenantId}.journey-api.test`,
    },
  });

  const serviceClaims = (roles: string[]): VerifiedOidcClaims => ({
    tenant_id: tenantId,
    tenant_slug: `journey-api-${tenantId}`,
    organization: { [`journey-api-${tenantId}`]: { tenant_id: [tenantId] } },
    azp: 'billing-events',
    sub: 'service-account-billing-events',
    preferred_username: 'service-account-billing-events',
    exp: 2_000_000_000,
    realm_access: { roles },
  });
  const verifier = {
    verifyAccessToken: async (token: string): Promise<VerifiedOidcClaims> => {
      if (token === 'service-token') return serviceClaims(['journey-ingress']);
      if (token === 'wrong-role-token') return serviceClaims(['viewer']);
      if (token === 'user-token') {
        return {
          ...serviceClaims(['journey-ingress']),
          dc_user_id: userId,
          sid: 'user-session',
        };
      }
      throw new Error('token ไม่ถูกต้อง');
    },
  };

  @Module({
    controllers: [JourneyEventController],
    providers: [
      { provide: JOURNEY_EVENT_INBOX, useValue: new EventInboxService(application) },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}

  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(async () => {
    await app.close();
    await owner.jrEventInbox.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const address = app.getHttpServer().address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${address.port}/api/v1/events`;
  const event = {
    source: 'billing',
    eventId: 'invoice-due-api-001',
    type: 'invoice.due',
    occurredAt: '2026-09-07T12:30:00.000Z',
    schemaVersion: 1,
    contactRef: { kind: 'EMAIL', value: 'customer@example.test' },
    payload: { invoiceId: 'invoice-api-001' },
  };
  const send = (token: string | undefined, body: unknown) =>
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  assert.equal((await send(undefined, event)).status, 401);
  assert.equal((await send('user-token', event)).status, 401);
  assert.equal((await send('wrong-role-token', event)).status, 403);
  assert.equal(
    (await send('service-token', { ...event, tenantId: 'attacker-tenant' })).status,
    400,
  );
  assert.equal(await owner.jrEventInbox.count({ where: { tenantId } }), 0);

  const accepted = await send('service-token', event);
  const acceptedBody = (await accepted.json()) as { receiptId: string };
  assert.equal(accepted.status, 202);
  assert.match(acceptedBody.receiptId, /^[0-9a-f-]{36}$/);
  const retried = await send('service-token', event);
  assert.equal(retried.status, 202);
  assert.deepEqual(await retried.json(), acceptedBody);
  assert.equal(await owner.jrEventInbox.count({ where: { tenantId } }), 1);

  const conflict = await send('service-token', {
    ...event,
    payload: { invoiceId: 'different-invoice' },
  });
  assert.equal(conflict.status, 409);
  assert.equal(((await conflict.json()) as { code: string }).code, 'IDEMPOTENCY_CONFLICT');
});

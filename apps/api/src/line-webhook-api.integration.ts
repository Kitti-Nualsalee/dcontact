/**
 * S2.5 (#369) — `POST /webhook/line` over real HTTP
 *
 * proves the edges that exist only over HTTP: the raw body reaches the handler without being reserialized, the route is public
 * (no bearer token) but still rejects a signature that fails, and acks within 2 seconds after the durable
 * commit per `S2-LINE-F03`
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import { LineWebhookIngress, lineSignature } from '@d-contact/delivery';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
import { LINE_WEBHOOK_INGRESS, LineWebhookController } from './line-webhook-api.js';

/** the Channel ID of the test OA per #356 — a public identifier, not a credential */
const PILOT_CHANNEL_ACCOUNT_ID = '2007056595';
const SECRET = 's2-synthetic-channel-secret';
const DESTINATION = 'U1234567890abcdef1234567890abcdef';
const PAYLOAD_KEY = randomBytes(32);

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

/** one synthetic tenant is enough for the HTTP edge — the LINE business fixture is in @d-contact/delivery */
async function createTenantFixture() {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantA = randomUUID();
  const suffix = tenantA.slice(0, 8);
  await owner.tenant.create({
    data: {
      id: tenantA,
      name: `S2.5 webhook ${suffix}`,
      slug: `s2-5-webhook-${suffix}`,
      sipDomain: `${suffix}.s2-5-webhook.test`,
    },
  });
  return {
    owner,
    application,
    tenantA,
    async dispose() {
      const where = { where: { tenantId: tenantA } };
      await owner.dlLineWebhookPayload.deleteMany(where);
      await owner.dlLineEventOutboxEntry.deleteMany(where);
      await owner.dlLineAuditEvent.deleteMany(where);
      await owner.dlLineWebhookInboxEntry.deleteMany(where);
      await owner.tenant.deleteMany({ where: { id: tenantA } });
      await Promise.all([owner.$disconnect(), application.$disconnect()]);
    },
  };
}

async function harness(t: TestContext) {
  const fixture = await createTenantFixture();
  const ingress = new LineWebhookIngress(fixture.application, {
    tenantId: fixture.tenantA,
    channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
    destination: DESTINATION,
    channelSecret: SECRET,
    payloadKeyRef: 'd-contact.line.webhook-payload/v1',
    payloadKey: PAYLOAD_KEY,
  });

  @Module({
    controllers: [LineWebhookController],
    providers: [
      { provide: LINE_WEBHOOK_INGRESS, useValue: ingress },
      {
        provide: OIDC_ACCESS_TOKEN_VERIFIER,
        useValue: {
          verifyAccessToken: async () => {
            throw new Error('the webhook route must not call the token verifier');
          },
        },
      },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}

  const app = await NestFactory.create(TestModule, { logger: false, rawBody: true });
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  t.after(async () => {
    await app.close();
    await fixture.dispose();
  });

  const post = async (body: string, signature?: string) => {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/webhook/line`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signature === undefined ? {} : { 'x-line-signature': signature }),
      },
      body,
    });
    return {
      status: response.status,
      body: (await response.json()) as { code: string },
      elapsedMs: Date.now() - started,
    };
  };
  const signed = (body: string) => post(body, lineSignature(Buffer.from(body, 'utf8'), SECRET));
  return { fixture, post, signed };
}

const requestBody = (events: unknown[]) => JSON.stringify({ destination: DESTINATION, events });

const messageEvent = (index: number) => ({
  type: 'message',
  mode: 'active',
  webhookEventId: `01JY${String(index).padStart(6, '0')}`,
  deliveryContext: { isRedelivery: false },
  timestamp: 1_790_100_000_000 + index,
  source: { type: 'user', userId: `U${'d'.repeat(32)}` },
  message: { id: `${700_000_000_000 + index}`, type: 'text', text: 'ขอบคุณครับ 🙏' }, // allow-thai: Thai LINE text round-trips through the raw body
});

test('S2-LINE-F03 the route is public but a failing signature answers 401 and writes nothing at all', async (t) => {
  const f = await harness(t);
  const body = requestBody([messageEvent(1)]);

  const missing = await f.post(body);
  const wrong = await f.post(body, 'ZGVhZGJlZWY=');
  for (const result of [missing, wrong]) {
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { code: 'WEBHOOK_SIGNATURE_INVALID' });
  }
  assert.equal(
    await f.fixture.owner.dlLineWebhookInboxEntry.count({ where: { tenantId: f.fixture.tenantA } }),
    0,
  );
});

test('S2-LINE-F03 the raw body reaches the handler without being reserialized and acks within 2 seconds', async (t) => {
  const f = await harness(t);
  // whitespace and emoji must survive — if the framework reserializes, the signature fails
  const body = `{"destination":"${DESTINATION}",\n  "events": [${JSON.stringify(messageEvent(2))}]\n}`;
  const accepted = await f.signed(body);

  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, { code: 'WEBHOOK_ACCEPTED' });
  assert.ok(accepted.elapsedMs < 2000, `the ack took ${accepted.elapsedMs}ms`);

  const rows = await f.fixture.owner.dlLineWebhookInboxEntry.findMany({
    where: { tenantId: f.fixture.tenantA },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, 'PENDING');

  // a verify request from the LINE Console
  const empty = await f.signed(requestBody([]));
  assert.deepEqual([empty.status, empty.body], [200, { code: 'WEBHOOK_EMPTY_VERIFICATION' }]);
  assert.equal(
    await f.fixture.owner.dlLineWebhookInboxEntry.count({ where: { tenantId: f.fixture.tenantA } }),
    1,
  );
});

test('S2-LINE-ID01 a redelivery over HTTP is a duplicate and adds no rows', async (t) => {
  const f = await harness(t);
  const body = requestBody([messageEvent(3)]);

  assert.deepEqual((await f.signed(body)).body, { code: 'WEBHOOK_ACCEPTED' });
  const again = await f.signed(body);
  assert.deepEqual([again.status, again.body], [200, { code: 'WEBHOOK_DUPLICATE' }]);
  assert.equal(
    await f.fixture.owner.dlLineWebhookInboxEntry.count({ where: { tenantId: f.fixture.tenantA } }),
    1,
  );
});

test('S2-LINE-OB02 the answer has only a machine code, with no payload or event ID going back', async (t) => {
  const f = await harness(t);
  const event = messageEvent(4);
  const result = await f.signed(requestBody([event]));
  const serialized = JSON.stringify(result.body);

  assert.deepEqual(Object.keys(result.body), ['code']);
  assert.ok(!serialized.includes(event.webhookEventId));
  assert.ok(!serialized.includes(event.source.userId));
  assert.ok(!serialized.includes('ขอบคุณครับ')); // allow-thai: Thai LINE text round-trips through the raw body
});

test('S2-LINE-F03 a prisma outage makes it answer 503, not 2xx', async (t) => {
  const fixture = await createTenantFixture();
  // a client pointing at a port nobody listens on: the commit can never succeed
  const broken = new PrismaClient({
    datasources: { db: { url: 'postgresql://dcontact_app:dcontact_app@127.0.0.1:1/dcontact' } },
  });
  const ingress = new LineWebhookIngress(broken, {
    tenantId: fixture.tenantA,
    channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
    destination: DESTINATION,
    channelSecret: SECRET,
    payloadKeyRef: 'd-contact.line.webhook-payload/v1',
    payloadKey: PAYLOAD_KEY,
  });

  @Module({
    controllers: [LineWebhookController],
    providers: [
      { provide: LINE_WEBHOOK_INGRESS, useValue: ingress },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: { verifyAccessToken: async () => ({}) } },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class BrokenModule {}

  const app = await NestFactory.create(BrokenModule, { logger: false, rawBody: true });
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  t.after(async () => {
    await app.close();
    await broken.$disconnect();
    await fixture.dispose();
  });

  const body = requestBody([messageEvent(5)]);
  const response = await fetch(`http://127.0.0.1:${port}/webhook/line`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-line-signature': lineSignature(Buffer.from(body, 'utf8'), SECRET),
    },
    body,
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: 'WEBHOOK_DURABILITY_UNAVAILABLE' });
});

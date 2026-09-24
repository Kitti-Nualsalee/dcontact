/**
 * `node dist/platform-worker-main.js` — worker ของ Platform provisioning (A1.6 #411)
 *
 * env: PLATFORM_DATABASE_URL, PROVISIONER_DATABASE_URL, PLATFORM_SIP_BASE_DOMAIN, KEYCLOAK_URL,
 * KEYCLOAK_PROVISIONER_SECRET (+ KEYCLOAK_REALM, KEYCLOAK_PROVISIONER_CLIENT_ID, MAILPIT_URL สำหรับ dev)
 */
import { hostname } from 'node:os';
import { PrismaClient } from '@d-contact/db';
import { KeycloakAdminClient } from './keycloak-admin.js';
import { createPlatformWorker, deliveryProbeFromEnv } from './platform-worker.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`ต้องตั้ง ${name}`);
  return value;
}

const platform = new PrismaClient({
  datasources: { db: { url: required('PLATFORM_DATABASE_URL') } },
});
const provisioner = new PrismaClient({
  datasources: { db: { url: required('PROVISIONER_DATABASE_URL') } },
});
const worker = createPlatformWorker({
  workerId: process.env.PLATFORM_WORKER_ID ?? `${hostname()}-${process.pid}`,
  platform,
  provisioner,
  keycloak: new KeycloakAdminClient({
    baseUrl: required('KEYCLOAK_URL'),
    realm: process.env.KEYCLOAK_REALM ?? 'dcontact',
    clientId: process.env.KEYCLOAK_PROVISIONER_CLIENT_ID ?? 'dcontact-provisioner',
    clientSecret: required('KEYCLOAK_PROVISIONER_SECRET'),
  }),
  sipBaseDomain: required('PLATFORM_SIP_BASE_DOMAIN'),
  probe: deliveryProbeFromEnv(process.env),
  log: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
});

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // หยุดรับงานใหม่; lease ที่ถืออยู่หมดอายุเองแล้ว worker อื่นรับช่วงได้
  process.on(signal, () => controller.abort());
}
await worker.run(controller.signal, Number(process.env.PLATFORM_WORKER_POLL_MS ?? 1_000));
await Promise.all([platform.$disconnect(), provisioner.$disconnect()]);

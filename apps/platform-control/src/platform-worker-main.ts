/**
 * `node dist/platform-worker-main.js` — worker ของ Platform provisioning (A1.6 #411)
 *
 * env: PLATFORM_DATABASE_URL, PROVISIONER_DATABASE_URL, PLATFORM_SIP_BASE_DOMAIN, KEYCLOAK_URL,
 * KEYCLOAK_PROVISIONER_SECRET, PLATFORM_PROVISIONING_ENABLED, PLATFORM_WORKER_METRICS_PORT (default 9464)
 * (+ KEYCLOAK_REALM, KEYCLOAK_PROVISIONER_CLIENT_ID, MAILPIT_URL สำหรับ dev)
 */
import { hostname } from 'node:os';
import { PrismaClient } from '@d-contact/db';
import { KeycloakAdminClient } from './keycloak-admin.js';
import { createPlatformWorker, deliveryProbeFromEnv } from './platform-worker.js';
import { Registry, collectDefaultMetrics } from 'prom-client';
import {
  PlatformHealthCollector,
  PlatformWorkerMetrics,
  startMetricsServer,
} from './platform-metrics.js';
import { PlatformRollout } from './platform-rollout.js';

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
// A1.8 (#413): /metrics บน port แยก (ไม่เปิดผ่าน ingress) — backlog/invariant อ่านจาก control plane DB
const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'dcontact_platform_worker_' });
new PlatformHealthCollector(platform, registry);
const metricsServer = await startMetricsServer(registry, {
  port: Number(process.env.PLATFORM_WORKER_METRICS_PORT ?? 9464),
  ...(process.env.PLATFORM_METRICS_HOST ? { host: process.env.PLATFORM_METRICS_HOST } : {}),
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
  // A1.8: default ปิด — ต้องตั้ง PLATFORM_PROVISIONING_ENABLED=true ให้ตรงกับ Platform API
  rollout: PlatformRollout.fromEnv(process.env),
  metrics: new PlatformWorkerMetrics(registry, platform),
  probe: deliveryProbeFromEnv(process.env),
  log: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
});

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // หยุดรับงานใหม่; lease ที่ถืออยู่หมดอายุเองแล้ว worker อื่นรับช่วงได้
  process.on(signal, () => controller.abort());
}
await worker.run(controller.signal, Number(process.env.PLATFORM_WORKER_POLL_MS ?? 1_000));
metricsServer.close();
await Promise.all([platform.$disconnect(), provisioner.$disconnect()]);

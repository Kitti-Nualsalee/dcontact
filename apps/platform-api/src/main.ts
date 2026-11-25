/**
 * Platform API — a process separate from the tenant API (`apps/api`) per #387: its own port, its own audience,
 * and (from A1.4 on) its own database role (`dcontact_platform` via `PLATFORM_DATABASE_URL`)
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import {
  PlatformRollout,
  startMetricsServer,
  startPlatformTracing,
} from '@d-contact/platform-control';
import { Registry, collectDefaultMetrics } from 'prom-client';
import { meteredDiagnostics } from './platform-metrics.js';
import { PlatformApiModule } from './platform-api.module.js';
import { createPlatformServices } from './platform-services.js';
import { JosePlatformAccessTokenVerifier } from './platform-verifier.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

async function bootstrap() {
  // A1.8b (#473): enabled only when OTEL_EXPORTER_OTLP_ENDPOINT is set
  const tracing = startPlatformTracing({ serviceName: 'dcontact-platform-api' });
  process.once('SIGTERM', () => void tracing.shutdown());
  const issuer = required('PLATFORM_OIDC_ISSUER');
  const verifier = JosePlatformAccessTokenVerifier.remote({
    issuer,
    jwksUri: process.env.PLATFORM_OIDC_JWKS_URI ?? `${issuer}/protocol/openid-connect/certs`,
  });
  // control-plane-only role (#387) — must not use the tenant application's DATABASE_URL
  const database = new PrismaClient({
    datasources: { db: { url: required('PLATFORM_DATABASE_URL') } },
  });
  // A1.8 (#413): /metrics on a separate port — not exposed through the Platform Console hostname
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'dcontact_platform_api_' });
  await startMetricsServer(registry, {
    port: Number(process.env.PLATFORM_API_METRICS_PORT ?? 9465),
    ...(process.env.PLATFORM_METRICS_HOST ? { host: process.env.PLATFORM_METRICS_HOST } : {}),
  });
  const app = await NestFactory.create(
    PlatformApiModule.register({
      verifier,
      // A1.8 (#413): off by default — PLATFORM_PROVISIONING_ENABLED=true + PLATFORM_OPERATOR_ALLOWLIST
      rollout: PlatformRollout.fromEnv(process.env),
      services: createPlatformServices(database, {
        sipBaseDomain: required('PLATFORM_SIP_BASE_DOMAIN'),
      }),
      diagnostics: meteredDiagnostics(
        { write: (diagnostic) => process.stdout.write(`${JSON.stringify(diagnostic)}\n`) },
        registry,
      ),
    }),
    { logger: ['error', 'warn'] },
  );
  app.enableCors({ origin: process.env.PLATFORM_CONSOLE_ORIGIN ?? 'http://localhost:5180' });
  await app.listen(Number(process.env.PLATFORM_API_PORT ?? 3010));
}

void bootstrap();

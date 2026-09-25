/**
 * Platform API — process แยกจาก tenant API (`apps/api`) ตาม #387: คนละ port, คนละ audience,
 * และ (A1.4 เป็นต้นไป) คนละ database role (`dcontact_platform` ผ่าน `PLATFORM_DATABASE_URL`)
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import { PlatformRollout } from '@d-contact/platform-control';
import { PlatformApiModule } from './platform-api.module.js';
import { createPlatformServices } from './platform-services.js';
import { JosePlatformAccessTokenVerifier } from './platform-verifier.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`ต้องตั้ง ${name}`);
  return value;
}

async function bootstrap() {
  const issuer = required('PLATFORM_OIDC_ISSUER');
  const verifier = JosePlatformAccessTokenVerifier.remote({
    issuer,
    jwksUri: process.env.PLATFORM_OIDC_JWKS_URI ?? `${issuer}/protocol/openid-connect/certs`,
  });
  // role เฉพาะ control plane (#387) — ห้ามใช้ DATABASE_URL ของ tenant application
  const database = new PrismaClient({
    datasources: { db: { url: required('PLATFORM_DATABASE_URL') } },
  });
  const app = await NestFactory.create(
    PlatformApiModule.register({
      verifier,
      // A1.8 (#413): default ปิด — PLATFORM_PROVISIONING_ENABLED=true + PLATFORM_OPERATOR_ALLOWLIST
      rollout: PlatformRollout.fromEnv(process.env),
      services: createPlatformServices(database, {
        sipBaseDomain: required('PLATFORM_SIP_BASE_DOMAIN'),
      }),
      diagnostics: {
        write: (diagnostic) => process.stdout.write(`${JSON.stringify(diagnostic)}\n`),
      },
    }),
    { logger: ['error', 'warn'] },
  );
  app.enableCors({ origin: process.env.PLATFORM_CONSOLE_ORIGIN ?? 'http://localhost:5180' });
  await app.listen(Number(process.env.PLATFORM_API_PORT ?? 3010));
}

void bootstrap();

/**
 * Platform API — process แยกจาก tenant API (`apps/api`) ตาม #387: คนละ port, คนละ audience,
 * และ (A1.4 เป็นต้นไป) คนละ database role (`dcontact_platform` ผ่าน `PLATFORM_DATABASE_URL`)
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { PlatformApiModule } from './platform-api.module.js';
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
  const app = await NestFactory.create(
    PlatformApiModule.register({
      verifier,
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

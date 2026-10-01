/**
 * Owner: API bootstrap — composition root ของ service `line-webhook` บน UAT (#565 S2, ADR-031)
 *
 * รับ LINE webhook อย่างเดียว: mount `POST /webhook/line` กับรายงาน profile และไม่มี controller อื่น
 * ไม่ import Kafka, Journey, voice, object storage หรือ OIDC verifier — ทุก route เป็น public เพราะ
 * authority ของ webhook คือ HMAC บน raw body (#359 §B) และ runtime profile ไม่มีข้อมูลลับ
 *
 * secret มาจากไฟล์ Compose `secrets` (`LINE_WEBHOOK_SECRET_SOURCE=file`) — profile `uat-line` ปฏิเสธโหมดอื่น
 * worker ของ inbox ไม่รันที่นี่ (#565 S3: ใช้ `pilot await-touch`; worker ต่อเนื่องอยู่ใน #566)
 */
import 'reflect-metadata';
import { Controller, Get, Inject, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import { LineWebhookIngress, resolveLineWebhookSecrets } from '@d-contact/delivery';
import { GatewayPublic } from './gateway-auth.js';
import { LINE_WEBHOOK_INGRESS, LineWebhookController } from './line-webhook-api.js';
import {
  RuntimeProfileRouteGuard,
  assertEntrypointProfile,
  type ApiRuntimeProfile,
} from './runtime-profile.js';

export const LINE_WEBHOOK_PROFILE_STATUS = Symbol('LINE_WEBHOOK_PROFILE_STATUS');

export interface LineWebhookProfileStatus {
  profile: ApiRuntimeProfile;
  routeGuard: RuntimeProfileRouteGuard;
}

/** healthcheck/readiness ของ service — คืนเฉพาะสถานะ ไม่มี tenant, channel หรือ config value */
@Controller('api/v1/runtime-profile')
export class LineWebhookProfileController {
  constructor(
    @Inject(LINE_WEBHOOK_PROFILE_STATUS) private readonly status: LineWebhookProfileStatus,
  ) {}

  @Get()
  @GatewayPublic()
  read() {
    const { profile, routeGuard } = this.status;
    return {
      profile: profile.name,
      kafka: profile.kafka,
      lineWebhook: profile.lineWebhook,
      providerEgress: profile.providerEgress,
      blockedRequests: routeGuard.blockedRequests(),
    };
  }
}

export class LineWebhookAppModule {}

export function createLineWebhookModule(dependencies: {
  ingress: unknown;
  status: LineWebhookProfileStatus;
}): DynamicModule {
  return {
    module: LineWebhookAppModule,
    controllers: [LineWebhookController, LineWebhookProfileController],
    providers: [
      { provide: LINE_WEBHOOK_INGRESS, useValue: dependencies.ingress },
      { provide: LINE_WEBHOOK_PROFILE_STATUS, useValue: dependencies.status },
    ],
  };
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function bootstrapLineWebhook(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const profile = assertEntrypointProfile('uat-line', environment);
  const log = { write: (diagnostic: object) => console.log(JSON.stringify(diagnostic)) };
  const routeGuard = new RuntimeProfileRouteGuard(profile, log);
  const channelAccountId = required(environment, 'LINE_WEBHOOK_CHANNEL_ACCOUNT_ID');
  // secret ไม่พร้อม = บูตไม่ผ่าน (ไม่ตกไปโหมด disabled ที่ตอบ 401 เงียบ ๆ)
  const secrets = await resolveLineWebhookSecrets({
    mode: environment.LINE_WEBHOOK_SECRET_SOURCE,
    channelAccountId,
    ...(environment.LINE_CREDENTIAL_DIR ? { secretDir: environment.LINE_CREDENTIAL_DIR } : {}),
  });
  const prisma = new PrismaClient();
  const ingress = new LineWebhookIngress(prisma, {
    tenantId: required(environment, 'LINE_WEBHOOK_TENANT_ID'),
    channelAccountId,
    destination: required(environment, 'LINE_WEBHOOK_DESTINATION'),
    channelSecret: secrets.channelSecret,
    payloadKeyRef: required(environment, 'LINE_WEBHOOK_PAYLOAD_KEY_REF'),
    payloadKey: secrets.payloadKey,
  });
  // rawBody: signature คำนวณบน bytes ที่ได้รับจริง (#359 §B)
  const app = await NestFactory.create(
    createLineWebhookModule({ ingress, status: { profile, routeGuard } }),
    { rawBody: true },
  );
  app.use(routeGuard.middleware);
  log.write({
    event: 'api.runtime_profile.started',
    profile: profile.name,
    kafka: profile.kafka,
    lineWebhook: profile.lineWebhook,
    providerEgress: profile.providerEgress,
  });
  await app.listen(Number(environment.PORT ?? 3000));
}

/**
 * Owner: API bootstrap — composition root ของ service `line-webhook` บน UAT (#565 S2, ADR-031)
 *
 * mount แค่สามอย่าง และไม่ import Kafka, Journey, voice หรือ object storage:
 * - `POST /webhook/line` — public; authority คือ HMAC บน raw body (#359 §B)
 * - `GET /api/v1/runtime-profile` — public; ไม่มีข้อมูลลับ
 * - `GET /api/v1/line-pilot/inbound` (#566) — OIDC + role admin ของ tenant pilot; Caddy ส่งมาหลัง CIDR allowlist
 *
 * secret มาจากไฟล์ Compose `secrets` (`LINE_WEBHOOK_SECRET_SOURCE=file`) — profile `uat-line` ปฏิเสธโหมดอื่น
 * worker ของ inbox ไม่รันที่นี่ (#565 S3, #566 R3: ใช้ `pilot await-touch`; worker ต่อเนื่องตัดสินใน #567)
 */
import 'reflect-metadata';
import { Controller, Get, Inject, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import {
  EncryptedLineWebhookPayloadVault,
  LineAuditRepository,
  LinePilotInboundReader,
  LineWebhookIngress,
  resolveLineWebhookSecrets,
} from '@d-contact/delivery';
import {
  CachedTenantLifecycleGate,
  KeycloakAccessTokenVerifier,
  type TenantLifecycleGate,
} from '@d-contact/workspace-session';
import {
  GATEWAY_DIAGNOSTICS,
  GatewayPublic,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
  type GatewayDiagnosticSink,
} from './gateway-auth.js';
import {
  LINE_PILOT_INBOUND_READER,
  LINE_PILOT_TENANT_ID,
  LinePilotInboundController,
} from './line-pilot-inbound-api.js';
import { LINE_WEBHOOK_INGRESS, LineWebhookController } from './line-webhook-api.js';
import {
  RuntimeProfileRouteGuard,
  assertEntrypointProfile,
  type ApiRuntimeProfile,
} from './runtime-profile.js';

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  /** #566: read API ของ pilot */
  inbound: unknown;
  tenantId: string;
  verifier: unknown;
  diagnostics: GatewayDiagnosticSink;
  lifecycle: TenantLifecycleGate;
}): DynamicModule {
  return {
    module: LineWebhookAppModule,
    controllers: [LineWebhookController, LineWebhookProfileController, LinePilotInboundController],
    providers: [
      { provide: LINE_WEBHOOK_INGRESS, useValue: dependencies.ingress },
      { provide: LINE_WEBHOOK_PROFILE_STATUS, useValue: dependencies.status },
      { provide: LINE_PILOT_INBOUND_READER, useValue: dependencies.inbound },
      { provide: LINE_PILOT_TENANT_ID, useValue: dependencies.tenantId },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: dependencies.verifier },
      { provide: GATEWAY_DIAGNOSTICS, useValue: dependencies.diagnostics },
      { provide: TENANT_LIFECYCLE, useValue: dependencies.lifecycle },
      // ทุก route ต้อง login ยกเว้นที่ประกาศ @GatewayPublic() (webhook + runtime profile)
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
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
  const tenantId = required(environment, 'LINE_WEBHOOK_TENANT_ID');
  // tenant ID ไม่ใช่ slug: RLS และ `tenant_id` ใน token เป็น UUID — slug ทำให้ ingress ล้มและ read API 403 ทุกครั้ง
  if (!TENANT_ID.test(tenantId))
    throw new Error('LINE_WEBHOOK_TENANT_ID must be a tenant UUID, not a slug');
  const payloadKeyRef = required(environment, 'LINE_WEBHOOK_PAYLOAD_KEY_REF');
  const ingress = new LineWebhookIngress(prisma, {
    tenantId,
    channelAccountId,
    destination: required(environment, 'LINE_WEBHOOK_DESTINATION'),
    channelSecret: secrets.channelSecret,
    payloadKeyRef,
    payloadKey: secrets.payloadKey,
  });
  const vault = new EncryptedLineWebhookPayloadVault(prisma, {
    key: (ref) => (ref === payloadKeyRef ? secrets.payloadKey : undefined),
  });
  const inbound = new LinePilotInboundReader(prisma, vault, new LineAuditRepository(prisma), {
    tenantId,
    channelAccountId,
  });
  // rawBody: signature คำนวณบน bytes ที่ได้รับจริง (#359 §B)
  const app = await NestFactory.create(
    createLineWebhookModule({
      ingress,
      status: { profile, routeGuard },
      inbound,
      tenantId,
      verifier: new KeycloakAccessTokenVerifier({
        issuer: required(environment, 'KEYCLOAK_ISSUER'),
        audience: required(environment, 'KEYCLOAK_AUDIENCE'),
        jwksUri: required(environment, 'KEYCLOAK_JWKS_URI'),
      }),
      diagnostics: log,
      lifecycle: new CachedTenantLifecycleGate((id) =>
        prisma.tenant
          .findUnique({ where: { id }, select: { lifecycleStatus: true } })
          .then((tenant) => tenant?.lifecycleStatus),
      ),
    }),
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

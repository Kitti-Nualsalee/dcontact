/**
 * Owner: API bootstrap — composition root ของ service `line-webhook` บน UAT (#565 S2, ADR-031)
 *
 * mount แค่สามอย่าง และไม่ import Kafka, Journey, voice หรือ object storage:
 * - `POST /webhook/line` — public; authority คือ HMAC บน raw body (#359 §B)
 * - `GET /api/v1/runtime-profile` — public; ไม่มีข้อมูลลับ
 * - `GET /api/v1/line-pilot/inbound` (#566) — OIDC + role admin ของ tenant pilot; Caddy ส่งมาหลัง CIDR allowlist
 *
 * secret มาจากไฟล์ Compose `secrets` (`LINE_WEBHOOK_SECRET_SOURCE=file`) — profile `uat-line` ปฏิเสธโหมดอื่น
 * #567 (team trial) — เปิดด้วย env และค่าเริ่มต้นคือปิดทั้งคู่:
 * - `LINE_TEAM_TRIAL=on`: mount ตอบกลับ/สถานะ/kill (`line-pilot-trial-api.ts`) และใช้ access token + egress
 *   ผ่าน relay (overlay `docker-compose.uat.line-trial.yml`)
 * - `LINE_WEBHOOK_WORKER=on`: worker loop ต่อเนื่องของ inbox (lease เดียวกับ `pilot await-touch`)
 */
import 'reflect-metadata';
import { Controller, Get, Inject, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import {
  EncryptedLineWebhookPayloadVault,
  FileLineSecretSource,
  HttpLineProviderTransport,
  KeychainLineAccessTokenResolver,
  KeychainLineRecipientResolver,
  LineAuditRepository,
  LineControlPlane,
  LineControlRepository,
  LineOutboundAdapter,
  LinePilotInboundReader,
  LineTeamTrialContentSource,
  LineTeamTrialReplies,
  LineTouchGovernanceAdapter,
  LineWebhookIngress,
  LineWebhookWorker,
  LineWebhookWorkerLoop,
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
import { LINE_TEAM_TRIAL, LinePilotTrialController } from './line-pilot-trial-api.js';
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
  /** #567: ไม่ระบุ = ไม่มี route ของ trial เลย (404) */
  trial?: unknown;
}): DynamicModule {
  return {
    module: LineWebhookAppModule,
    controllers: [
      LineWebhookController,
      LineWebhookProfileController,
      LinePilotInboundController,
      ...(dependencies.trial ? [LinePilotTrialController] : []),
    ],
    providers: [
      ...(dependencies.trial ? [{ provide: LINE_TEAM_TRIAL, useValue: dependencies.trial }] : []),
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
  const keyring = {
    key: (ref: string) => (ref === payloadKeyRef ? secrets.payloadKey : undefined),
  };
  const vault = new EncryptedLineWebhookPayloadVault(prisma, keyring);
  const inbound = new LinePilotInboundReader(prisma, vault, new LineAuditRepository(prisma), {
    tenantId,
    channelAccountId,
  });
  const trialEnabled = environment.LINE_TEAM_TRIAL === 'on';
  const workerEnabled = environment.LINE_WEBHOOK_WORKER === 'on';
  const governance = trialEnabled || workerEnabled ? new ContactGovernanceService(prisma) : null;
  const trial = trialEnabled ? createTeamTrial() : undefined;
  function createTeamTrial(): LineTeamTrialReplies {
    // secret ของ trial (token) + recipient จาก state ของ runner — ไฟล์เดียวกับที่ runner ใช้ (#565 S4)
    const source = new FileLineSecretSource({
      channelAccountId,
      stateDir: required(environment, 'LINE_PILOT_STATE_DIR'),
      ...(environment.LINE_CREDENTIAL_DIR ? { secretDir: environment.LINE_CREDENTIAL_DIR } : {}),
    });
    const control = new LineControlPlane({
      control: new LineControlRepository(prisma),
      audit: new LineAuditRepository(prisma),
    });
    const transport = new HttpLineProviderTransport();
    const credentials = new KeychainLineAccessTokenResolver(prisma, source);
    const recipients = new KeychainLineRecipientResolver(prisma, source);
    const content = new LineTeamTrialContentSource(prisma, keyring);
    const executor = { role: 'PLATFORM_OPERATOR' as const, ref: 'line-team-trial' };
    return new LineTeamTrialReplies({
      database: prisma,
      control,
      governance: governance!,
      adapter: (configDigest) =>
        new LineOutboundAdapter({
          database: prisma,
          governance: governance!,
          control,
          transport,
          recipients,
          credentials,
          actor: executor,
          configDigest,
          content,
        }),
      vault,
      payloadKey: { keyRef: payloadKeyRef, key: secrets.payloadKey },
      credentials,
      transport,
      scope: {
        tenantId,
        channelAccountId,
        senderIdentityId: required(environment, 'LINE_PILOT_SENDER_IDENTITY_ID'),
        purpose: 'SERVICE_NOTIFICATION',
        contactKind: 'SERVICE',
      },
      executor,
    });
  }
  const worker = workerEnabled
    ? new LineWebhookWorkerLoop({
        worker: new LineWebhookWorker({
          database: prisma,
          payloads: vault,
          governance: new LineTouchGovernanceAdapter(prisma, governance!),
          leaseOwner: `line-webhook-${process.pid}`,
        }),
        tenantId,
        onTick: (event) => {
          if (event.kind === 'failed') {
            log.write({ event: 'line.webhook_worker.failed', backoffMs: event.backoffMs });
          }
        },
      })
    : undefined;

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
      ...(trial ? { trial } : {}),
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
    teamTrial: trialEnabled ? 'ON' : 'OFF',
    worker: workerEnabled ? 'ON' : 'OFF',
  });
  if (worker) {
    worker.start();
    // SIGTERM จาก docker: หยุดรับรอบใหม่ รอ batch ปัจจุบันจบ แล้วปิด HTTP
    process.once('SIGTERM', () => {
      void worker.stop().then(() => app.close());
    });
  }
  await app.listen(Number(environment.PORT ?? 3000));
}

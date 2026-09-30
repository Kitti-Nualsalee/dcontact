import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Controller, Module, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { EventInboxService, JourneyTemplateRepository } from '@d-contact/journey';
import { LineWebhookIngress, resolveLineWebhookSecrets } from '@d-contact/delivery';
import { DcExprEvaluator } from '@d-contact/expression';
import { IamJourneyAuthoringAuthorizer } from '@d-contact/iam';
import { createConsumer, createInMemoryIdempotencyStore } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import {
  KeycloakAccessTokenVerifier,
  WorkspaceSessionGateway,
  CachedTenantLifecycleGate,
  WorkspaceSessionHttpAdapter,
  WorkspaceSessionRegistry,
  WorkspaceSessionWebSocketAdapter,
} from '@d-contact/workspace-session';
import { createWorkspaceSessionHandler } from './workspace-session-api.js';
import { WorkSessionLeases } from './work-session.js';
import { EmbedOriginService } from './embed-origins.js';
import {
  DPHONE_EMBED_SHELL_OPTIONS,
  DphoneEmbedController,
  EMBED_ORIGIN_SERVICE,
  EmbedOriginsController,
} from './embed-origins-api.js';
import { DphoneAuthCallbackController } from './dphone-auth-callback.js';
import {
  DPHONE_LAUNCHER_OPTIONS,
  DphoneLauncherController,
  defaultLauncherReleasesDir,
} from './dphone-launcher-api.js';
import {
  ContactGovernanceDisclosureCheck,
  IamTeamSegmentViewScope,
  ScreenPopService,
} from './screen-pop.js';
import { SCREEN_POP_SERVICE, ScreenPopController } from './screen-pop-api.js';
import { ClickToCallService } from './click-to-call.js';
import { CLICK_TO_CALL_SERVICE, ClickToCallController } from './click-to-call-api.js';
import { WORK_SESSION_LEASES, WorkSessionController } from './work-session-api.js';
import { attachWorkspaceSessionWebSocket } from './workspace-session-websocket.js';
import {
  GATEWAY_DIAGNOSTICS,
  GatewayRoles,
  OIDC_ACCESS_TOKEN_VERIFIER,
  TENANT_LIFECYCLE,
  OidcGlobalGuard,
  type GatewayDiagnosticSink,
} from './gateway-auth.js';
import {
  QueueAuditController,
  QueueController,
  TENANT_QUEUE_DATABASE,
  TenantQueuePolicyController,
  VoiceDestinationController,
} from './tenant-queue-api.js';
import { fanoutAgentOffer } from './agent-offer-fanout.js';
import {
  SupervisorLiveController,
  SUPERVISOR_LIVE_DATABASE,
  SupervisorLiveEventStream,
} from './supervisor-live-api.js';
import {
  RecordingController,
  RECORDING_DATABASE,
  RECORDING_STORAGE,
  TELEPHONY_COMMAND_PUBLISHER,
} from './recording-api.js';
import { KafkaTelephonyCommandPublisher } from './recording-command-publisher.js';
import {
  TEAM_SEGMENT_SCOPE_DATABASE,
  TeamSegmentScopeController,
} from './team-segment-scope-api.js';
import { S3RecordingStorage } from './s3-recording-storage.js';
import { S3GovernanceExportStorage } from './s3-governance-export-storage.js';
import { QmController, QM_DATABASE, QM_JOB_PUBLISHER } from './qm-api.js';
import { KafkaQmJobPublisher } from './qm-job-publisher.js';
import { AgentWorkspaceController, AGENT_WORKSPACE_DATABASE } from './agent-workspace-api.js';
import {
  AGENT_SIP_CREDENTIALS,
  configuredAgentSipCredentialService,
  FreeSwitchDirectoryController,
} from './agent-sip-credentials.js';
import { JOURNEY_EVENT_INBOX, JourneyEventController } from './journey-event-api.js';
import {
  JOURNEY_RECOVERY_DATABASE,
  JourneyOwnerRecoveryController,
} from './journey-owner-recovery-api.js';
import {
  JOURNEY_AUTHORING_REPOSITORY,
  JourneyAuthoringController,
} from './journey-authoring-api.js';
import { JourneyTemplateController } from './journey-template-api.js';
import { LINE_WEBHOOK_INGRESS, LineWebhookController } from './line-webhook-api.js';
import { TENANT_LOCALE_DATABASE, TenantLocaleDefaultsController } from './tenant-locale-api.js';
import {
  NAVIGATION_DATABASE,
  NAVIGATION_REGISTRY_PROVIDER,
  NavigationController,
} from './navigation-api.js';
import {
  JOURNEY_SEGMENT_DATABASE,
  JourneySegmentRecoveryController,
} from './journey-segment-recovery-api.js';
import {
  CONTACT_GOVERNANCE_DATABASE,
  ContactGovernanceCallbackRequestsController,
  ContactGovernanceContactQueryController,
  ContactGovernanceDecisionQueryController,
  ContactGovernancePoliciesController,
  ContactGovernancePreferencesController,
} from './contact-governance-api.js';
import { Redis } from 'ioredis';
import { Cg5QueryCache, ContactGovernanceService } from '@d-contact/contact-governance';
import { TenantClientRateLimiter } from './tenant-client-rate-limiter.js';
import { assertEntrypointProfile } from './runtime-profile.js';
import {
  CG5_TENANT_CLIENT_RATE_LIMITER,
  ContactGovernanceExternalReadController,
} from './contact-governance-external-read-api.js';
import {
  CG5_EXPORT_STORAGE,
  ContactGovernanceCg5ExportController,
} from './contact-governance-cg5-export-api.js';
import {
  CG5_QUERY_CACHE,
  ContactGovernanceCg5QueryController,
} from './contact-governance-cg5-api.js';
import {
  CG4_API_CONTROLLERS,
  CG4_DATABASE,
  CG4_EVIDENCE_ACCESS_SINK,
} from './contact-governance-cg4-api.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

// U1.2 (#430): composition root นี้เปิด Kafka/LINE/telephony — ห้ามบูตด้วย UAT profile (ใช้ `uat-main.ts`)
assertEntrypointProfile('default');

const prisma = new PrismaClient();
const cg5QueryCache = new Cg5QueryCache(
  new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'),
);
const cg5TenantClientRateLimiter = new TenantClientRateLimiter();
const verifier = new KeycloakAccessTokenVerifier({
  issuer: required('KEYCLOAK_ISSUER'),
  audience: required('KEYCLOAK_AUDIENCE'),
  jwksUri: required('KEYCLOAK_JWKS_URI'),
});
// A1.8a (#447): tenant ที่ยังไม่ ACTIVE (เช่นยัง provisioning) เข้า tenant API/workspace ไม่ได้
const tenantLifecycle = new CachedTenantLifecycleGate((tenantId) =>
  prisma.tenant
    .findUnique({ where: { id: tenantId }, select: { lifecycleStatus: true } })
    .then((tenant) => tenant?.lifecycleStatus),
);
const gateway = new WorkspaceSessionGateway(
  verifier,
  new WorkspaceSessionRegistry(),
  tenantLifecycle,
);
const supervisorLiveEvents = new SupervisorLiveEventStream();
const recordingCommandPublisher = new KafkaTelephonyCommandPublisher();
const agentSipCredentials = configuredAgentSipCredentialService(prisma);
const recordingStorage = new S3RecordingStorage();
const governanceExportStorage = new S3GovernanceExportStorage();
const qmJobPublisher = new KafkaQmJobPublisher();
const journeyEventInbox = new EventInboxService(prisma);
/**
 * S2.5 (#369): singleton webhook binding ของ pilot — ค่าทั้งหมดมาจาก deployment config
 * ไม่ใช่จาก body ของ request; ไม่มี binding = route ปฏิเสธทุก request ด้วย signature ที่ตรวจไม่ผ่าน
 */
// S2.6b (#403): secret ไม่มาจาก env อีกต่อไป — env เลือกได้แค่โหมด (#362 §9) และอ่าน Keychain ตอนบูต
async function createLineWebhookIngress(): Promise<LineWebhookIngress> {
  const secrets = await resolveLineWebhookSecrets({
    mode: process.env.LINE_WEBHOOK_SECRET_SOURCE,
    channelAccountId: required('LINE_WEBHOOK_CHANNEL_ACCOUNT_ID'),
  });
  return new LineWebhookIngress(prisma, {
    tenantId: required('LINE_WEBHOOK_TENANT_ID'),
    channelAccountId: required('LINE_WEBHOOK_CHANNEL_ACCOUNT_ID'),
    destination: required('LINE_WEBHOOK_DESTINATION'),
    channelSecret: secrets.channelSecret,
    payloadKeyRef: required('LINE_WEBHOOK_PAYLOAD_KEY_REF'),
    payloadKey: secrets.payloadKey,
  });
}
// J5.5: feature flag มาจาก env kill switch (default ปิด) AND rollout row ของ tenant ภายใน repository
const journeyAuthoring = new JourneyTemplateRepository(prisma, {
  authorization: new IamJourneyAuthoringAuthorizer(),
  evaluator: new DcExprEvaluator(),
});
const httpAdapter = new WorkspaceSessionHttpAdapter(gateway);
async function tenantScope<T>(tenantId: string, work: () => Promise<T> | T): Promise<T> {
  return withTenantDatabaseTransaction(prisma, tenantId, async (transaction) => {
    const tenant = await transaction.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) throw new UnauthorizedException('tenant context is not provisioned');
    return work();
  });
}
// E1.9 (#483): work-session lease — บังคับเมื่อ tenant เปิด `workSession.lease.enforced`
const leaseSignals: { forward?: WorkspaceSessionWebSocketAdapter } = {};
// E1.11 (#485): allowlist ของ dphone embedding — localhost ได้เฉพาะ dev (ไม่ใช่ production)
const embedOrigins = new EmbedOriginService(prisma, {
  allowLocalhost: process.env.NODE_ENV !== 'production',
  reservedOrigins: (process.env.DCONTACT_RESERVED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  revocations: {
    revoked: (tenantId, origin) =>
      void leaseSignals.forward?.notifyEmbedOriginRevoked(tenantId, origin),
  },
});
const workSessionLeases = new WorkSessionLeases(prisma, {
  signals: {
    signal: (tenantId, userId, signal) =>
      void leaseSignals.forward?.signalLease(tenantId, userId, signal),
  },
  diagnostics: { write: (event) => console.log(JSON.stringify(event)) },
  embedOrigins,
  sipRegistrations: {
    flush: (registration) => {
      void recordingCommandPublisher
        .publish({
          tenantId: registration.tenantId,
          command: {
            type: 'sip.registration.flush',
            vendor: 'freeswitch',
            telephonyNodeId: registration.telephonyNodeId,
            extension: registration.extension,
            sipDomain: registration.sipDomain,
            workSessionLeaseId: registration.workSessionLeaseId,
          },
        })
        .catch((error: unknown) =>
          console.error('[api] SIP registration flush publish failed', error),
        );
    },
  },
});
// E1.17 (#519): IAM VIEW scope เป็น authority ของ screen-pop; deny/stale/revoked ยังคง fail closed
const screenPop = new ScreenPopService(prisma, {
  hostOriginOfLease: (actor, leaseId) => workSessionLeases.embeddedHostOrigin(actor, leaseId),
  screenPopLevel: (tenantId, origin) => embedOrigins.screenPopLevel(tenantId, origin),
  disclosure: new ContactGovernanceDisclosureCheck(prisma, new IamTeamSegmentViewScope(prisma)),
});
// E1.14 (#488): click-to-call ขออนุญาตจาก Contact Governance เท่านั้น — โทรจริงรอ E1.18 #520
const clickToCall = new ClickToCallService(prisma, {
  hostOriginOfLease: (actor, leaseId) => workSessionLeases.embeddedHostOrigin(actor, leaseId),
  governance: new ContactGovernanceService(prisma),
});
const socketAdapter = new WorkspaceSessionWebSocketAdapter(
  gateway,
  tenantScope,
  { write: (diagnostic) => console.log(JSON.stringify(diagnostic)) },
  workSessionLeases,
);
leaseSignals.forward = socketAdapter;
// ปล่อย lease ที่หลุดตอนว่างเกิน TTL (presence → OFFLINE); ทุก instance รันได้เพราะ lock แถวก่อนปิด
setInterval(() => {
  workSessionLeases
    .sweep()
    .catch((error) =>
      console.error(JSON.stringify({ event: 'work_session.sweep_failed', error: String(error) })),
    );
}, 15_000).unref();
supervisorLiveEvents.subscribe(async (event, recipientUserIds) => {
  await socketAdapter.deliverLiveEvent(event, recipientUserIds);
});
const handleWorkspaceSession = createWorkspaceSessionHandler(httpAdapter, tenantScope);

const diagnostics: GatewayDiagnosticSink = {
  write: (diagnostic) => console.log(JSON.stringify(diagnostic)),
};

@Controller('api/v1/workspace-session')
class WorkspaceSessionController {
  @Post('connect')
  @GatewayRoles('agent', 'supervisor', 'admin')
  async connect(@Req() request: IncomingMessage, @Res() response: ServerResponse): Promise<void> {
    await handleWorkspaceSession(request, response);
  }
}

@Module({
  controllers: [
    WorkspaceSessionController,
    QueueController,
    TenantQueuePolicyController,
    VoiceDestinationController,
    QueueAuditController,
    SupervisorLiveController,
    RecordingController,
    QmController,
    AgentWorkspaceController,
    TeamSegmentScopeController,
    FreeSwitchDirectoryController,
    WorkSessionController,
    EmbedOriginsController,
    ScreenPopController,
    ClickToCallController,
    DphoneEmbedController,
    DphoneLauncherController,
    DphoneAuthCallbackController,
    JourneyEventController,
    JourneyOwnerRecoveryController,
    JourneySegmentRecoveryController,
    JourneyAuthoringController,
    JourneyTemplateController,
    LineWebhookController,
    ContactGovernancePreferencesController,
    ContactGovernanceCallbackRequestsController,
    ContactGovernancePoliciesController,
    ContactGovernanceContactQueryController,
    ContactGovernanceDecisionQueryController,
    ContactGovernanceExternalReadController,
    ContactGovernanceCg5QueryController,
    ContactGovernanceCg5ExportController,
    ...CG4_API_CONTROLLERS,
    TenantLocaleDefaultsController,
    NavigationController,
  ],
  providers: [
    { provide: TENANT_QUEUE_DATABASE, useValue: prisma },
    { provide: TENANT_LOCALE_DATABASE, useValue: prisma },
    { provide: NAVIGATION_DATABASE, useValue: prisma },
    NAVIGATION_REGISTRY_PROVIDER,
    { provide: CONTACT_GOVERNANCE_DATABASE, useValue: prisma },
    { provide: CG5_QUERY_CACHE, useValue: cg5QueryCache },
    { provide: CG5_TENANT_CLIENT_RATE_LIMITER, useValue: cg5TenantClientRateLimiter },
    { provide: CG5_EXPORT_STORAGE, useValue: governanceExportStorage },
    { provide: CG4_DATABASE, useValue: prisma },
    {
      // Evidence access is itself auditable (#190): opaque ids only, no evidence body.
      provide: CG4_EVIDENCE_ACCESS_SINK,
      useValue: {
        record: (access: Record<string, unknown>) =>
          console.log(JSON.stringify({ event: 'contact_governance.evidence.read', ...access })),
      },
    },
    { provide: SUPERVISOR_LIVE_DATABASE, useValue: prisma },
    { provide: SupervisorLiveEventStream, useValue: supervisorLiveEvents },
    { provide: RECORDING_DATABASE, useValue: prisma },
    { provide: TELEPHONY_COMMAND_PUBLISHER, useValue: recordingCommandPublisher },
    { provide: RECORDING_STORAGE, useValue: recordingStorage },
    { provide: QM_DATABASE, useValue: prisma },
    { provide: QM_JOB_PUBLISHER, useValue: qmJobPublisher },
    { provide: AGENT_WORKSPACE_DATABASE, useValue: prisma },
    { provide: TEAM_SEGMENT_SCOPE_DATABASE, useValue: prisma },
    { provide: WORK_SESSION_LEASES, useValue: workSessionLeases },
    { provide: EMBED_ORIGIN_SERVICE, useValue: embedOrigins },
    // E1.15 (#489): `<dphone-launcher>` แบบ versioned/alias บน dphone origin
    { provide: DPHONE_LAUNCHER_OPTIONS, useValue: { releasesDir: defaultLauncherReleasesDir() } },
    { provide: SCREEN_POP_SERVICE, useValue: screenPop },
    { provide: CLICK_TO_CALL_SERVICE, useValue: clickToCall },
    {
      provide: DPHONE_EMBED_SHELL_OPTIONS,
      useValue: {
        // Vite entry แยกของ embed ใน apps/workspace (dev = vite dev server)
        scriptUrl:
          process.env.DPHONE_EMBED_SCRIPT_URL ??
          (process.env.NODE_ENV === 'production'
            ? undefined
            : 'http://localhost:5173/src/embed/main.ts'),
        connectSrc: (process.env.DPHONE_EMBED_CONNECT_SRC ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        auth: {
          issuer: required('KEYCLOAK_ISSUER'),
          clientId: process.env.DPHONE_EMBEDDED_CLIENT_ID ?? 'dphone-embedded',
        },
      },
    },
    { provide: AGENT_SIP_CREDENTIALS, useValue: agentSipCredentials },
    { provide: JOURNEY_EVENT_INBOX, useValue: journeyEventInbox },
    { provide: JOURNEY_RECOVERY_DATABASE, useValue: prisma },
    { provide: JOURNEY_SEGMENT_DATABASE, useValue: prisma },
    { provide: JOURNEY_AUTHORING_REPOSITORY, useValue: journeyAuthoring },
    { provide: LINE_WEBHOOK_INGRESS, useFactory: createLineWebhookIngress },
    { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier },
    { provide: GATEWAY_DIAGNOSTICS, useValue: diagnostics },
    { provide: TENANT_LIFECYCLE, useValue: tenantLifecycle },
    { provide: APP_GUARD, useClass: OidcGlobalGuard },
  ],
})
class AppModule {}

async function bootstrap(): Promise<void> {
  // rawBody: LINE signature คำนวณบน bytes ที่ได้รับจริง reserialize แล้ว verify ไม่ผ่าน (#359 §B)
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors({
    origin: process.env.WORKSPACE_ORIGIN ?? 'http://localhost:5173',
    allowedHeaders: [
      'authorization',
      'content-type',
      'x-correlation-id',
      'x-work-session-lease-id',
      'idempotency-key',
      'if-none-match',
    ],
    exposedHeaders: ['x-correlation-id', 'etag', 'retry-after'],
  });
  attachWorkspaceSessionWebSocket(app.getHttpServer(), socketAdapter);
  await createConsumer({
    clientId: 'dcontact-api',
    groupId: 'dcontact-api-routing-offer-v1',
    topics: [KAFKA_TOPICS.AGENT_EVENTS],
    idempotency: createInMemoryIdempotencyStore(),
    handler: async ({ event }) => {
      if (event.type === 'routing.offered') await fanoutAgentOffer(socketAdapter, event);
    },
  });
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();

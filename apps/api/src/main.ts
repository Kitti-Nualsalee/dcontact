import { Customer360WorkController, CUSTOMER_360_WORK_AUTH } from './customer-360-work-api.js';
import { C360WorkAuthService, KeycloakC360TokenIntrospector } from './customer-360-work-auth.js';
import { c360WorkReadiness, resolveC360WorkConfig } from './customer-360-work-config.js';
import {
  CUSTOMER_360_TAG_RUNTIME,
  createC360TagCatalogRuntime,
} from './customer-360-tag-runtime.js';
import { Customer360TagCatalogController } from './customer-360-tag-catalog-api.js';
import { Customer360Controller, CUSTOMER_360_DATABASE } from './customer-360-api.js';
import { Customer360ImportController } from './customer-360-import-api.js';
import { Customer360OperatorController } from './customer-360-operator-api.js';
import { Customer360ActivityController } from './customer-360-activity-api.js';
import { Customer360OverviewController } from './customer-360-overview-api.js';
import { Customer360ReadController } from './customer-360-read-api.js';
import { Customer360ServiceApi } from './customer-360-service-api.js';
import {
  c360ServiceApiReadiness,
  resolveC360ServiceApiEnabled,
} from './customer-360-service-config.js';
import { CUSTOMER_360_SERVICE_API } from './customer-360-service-port.js';
import {
  CUSTOMER_360_WRITE_RUNTIME,
  createC360WriteRuntime,
} from './customer-360-write-runtime.js';
import { TenantCoreSettingsController, TENANT_CORE_DATABASE } from './tenant-core-api.js';
import { withLocalAccountAdmission } from './local-account-verifier.js';
import 'reflect-metadata';
import { TenantVoiceCatalogController, TENANT_VOICE_DATABASE } from './tenant-voice-catalog-api.js';
import { TenantPeopleController } from './tenant-people-api.js';
import { TENANT_PEOPLE_READINESS } from './tenant-people-readiness.js';
import { configuredPeopleRuntime } from './tenant-people-composition.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Controller, Module, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { EventInboxService, JourneyTemplateRepository } from '@d-contact/journey';
import {
  LineWebhookIngress,
  resolveLineWebhookSecrets,
  VoiceOriginateDeliveryService,
  VoiceOriginateOutcomeProcessor,
  VoiceRolloutControlPlane,
  VoiceTelephonyOutcomeHandler,
} from '@d-contact/delivery';
import { DcExprEvaluator } from '@d-contact/expression';
import { IamJourneyAuthoringAuthorizer } from '@d-contact/iam';
import { createConsumer, createInMemoryIdempotencyStore } from '@d-contact/kafka';
import { KAFKA_TOPICS, type TelephonyCallEvent } from '@d-contact/shared';
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
import { startBackgroundLoop } from './background-loop.js';
import { startC360SegmentWorker } from './customer-360-segment-worker.js';
import { EmbedOriginService } from './embed-origins.js';
import { AccountPolicyService } from './account-policy.js';
import { ACCOUNT_SELF_SERVICE, AccountController } from './account-api.js';
import { AccountSecretBox, KeycloakAccountIdentity } from './account-identity.js';
import { AccountSelfService } from './account-self-service.js';
import {
  AccountEmailDispatcher,
  SmtpEmailSender,
  smtpConfigFromEnvironment,
} from './account-email.js';
import { consoleAccountUrl } from './account-email-templates.js';
import {
  KeycloakAccountServiceClient,
  KeycloakOrganizationMfa,
} from './keycloak-account-service.js';
import { ACCOUNT_POLICY_SERVICE, AccountPolicyController } from './account-policy-api.js';
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
import { resolveWebchat } from './webchat-config.js';
import { WebchatHub } from './webchat-hub.js';
import { WebchatService } from './webchat-service.js';
import {
  WEBCHAT_SERVICE,
  WEBCHAT_WIDGET_DIR,
  WebchatPublicController,
  defaultWebchatWidgetDir,
} from './webchat-public-api.js';
import {
  WEBCHAT_DATABASE,
  WebchatAgentController,
  WebchatWidgetController,
} from './webchat-agent-api.js';
import {
  SupervisorLiveController,
  SUPERVISOR_LIVE_DATABASE,
  SupervisorLiveEventStream,
} from './supervisor-live-api.js';
import {
  RecordingController,
  RECORDING_DATABASE,
  RECORDING_STORAGE,
  RECORDING_SUPERVISOR_PLAYBACK,
  TELEPHONY_COMMAND_PUBLISHER,
} from './recording-api.js';
import { KafkaTelephonyCommandPublisher } from './recording-command-publisher.js';
import {
  RECORDING_PLAYBACK_STORAGE,
  RecordingPlaybackController,
} from './recording-playback-api.js';
import { resolveRecordingSupervisorPlayback } from './recording-playback-config.js';
import {
  TEAM_HISTORY_DATABASE,
  TEAM_HISTORY_WEBCHAT,
  TeamHistoryController,
} from './team-history.js';
import {
  TEAM_SEGMENT_SCOPE_DATABASE,
  TeamSegmentScopeController,
} from './team-segment-scope-api.js';
import { S3RecordingStorage } from './s3-recording-storage.js';
import { S3GovernanceExportStorage } from './s3-governance-export-storage.js';
import { QmController, QM_DATABASE, QM_JOB_PUBLISHER } from './qm-api.js';
import {
  QmEvaluationController,
  QM_EVALUATION_DATABASE,
  QM_HUMAN_EVALUATION,
} from './qm-evaluation-api.js';
import { resolveQmHumanEvaluation } from './qm-evaluation-config.js';
import { KafkaQmJobPublisher } from './qm-job-publisher.js';
import {
  AgentWorkspaceController,
  AGENT_WORKSPACE_DATABASE,
  AGENT_WORKSPACE_CUSTOMER_AVAILABLE,
  AGENT_WORKSPACE_WEBCHAT,
} from './agent-workspace-api.js';
import { AgentCasesController, AGENT_CASES_DATABASE } from './agent-cases-api.js';
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
import {
  CUSTOMER_360_SEARCH_LIMITER,
  createCustomer360SearchLimiter,
} from './shared-rate-limiter.js';
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

// U1.2 (#430): this composition root enables Kafka/LINE/telephony — it must not boot with the UAT profile (use `uat-main.ts`)
assertEntrypointProfile('default');

const prisma = new PrismaClient();
const cg5QueryCache = new Cg5QueryCache(
  new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'),
);
const cg5TenantClientRateLimiter = new TenantClientRateLimiter();
// Missing Redis configuration fails search closed without disabling other API routes.
const c360SearchLimiter = createCustomer360SearchLimiter(process.env.REDIS_URL);
const verifier = withLocalAccountAdmission(
  prisma,
  new KeycloakAccessTokenVerifier({
    issuer: required('KEYCLOAK_ISSUER'),
    audience: required('KEYCLOAK_AUDIENCE'),
    jwksUri: required('KEYCLOAK_JWKS_URI'),
  }),
);
// AC1/AC2 (#594/#595): 2FA enforcement syncs to the Organization through the `dc-account` extension — without the account
// service secret there is no port and enabling 2FA enforcement answers 409 MFA_ENFORCEMENT_UNAVAILABLE (a value that cannot be enforced is not saved)
const accountServiceSecret = process.env.KEYCLOAK_ACCOUNT_SERVICE_SECRET;
const accountServiceClient = accountServiceSecret
  ? new KeycloakAccountServiceClient({
      issuer: required('KEYCLOAK_ISSUER'),
      clientSecret: accountServiceSecret,
    })
  : undefined;
const accountPolicies = new AccountPolicyService(prisma, {
  ...(accountServiceClient ? { mfa: new KeycloakOrganizationMfa(accountServiceClient) } : {}),
});
// AC4 (#597): account self-service — needs both the account service and the key that encrypts the TOTP secret
// (`ACCOUNT_SECRET_KEY` = base64 of 32 bytes); incomplete = every endpoint answers 503 IDENTITY_UNAVAILABLE
const accountSecretKey = process.env.ACCOUNT_SECRET_KEY;
const accountSelfService =
  accountServiceClient && accountSecretKey
    ? new AccountSelfService(
        prisma,
        new KeycloakAccountIdentity(accountServiceClient),
        new AccountSecretBox(accountSecretKey),
      )
    : null;
// AC3 (#596): D-Contact account email through the outbox — without SMTP_HOST the sender is not enabled (work stays in the outbox)
const smtpConfig = smtpConfigFromEnvironment(process.env);
if (smtpConfig) {
  const consoleUrl = required('CONSOLE_PUBLIC_URL');
  consoleAccountUrl(consoleUrl); // https only (except localhost) — if wrong, stop at boot
  new AccountEmailDispatcher(prisma, new SmtpEmailSender(smtpConfig), { consoleUrl }).start();
}
// A1.8a (#447): a tenant that is not yet ACTIVE (e.g. still provisioning) cannot enter the tenant API/workspace
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
// #967: off by default; when on, the existing recording presign route answers 403
const recordingSupervisorPlayback = resolveRecordingSupervisorPlayback(process.env);
// #971: off by default; when on, human evaluation forms/results and the Admin, Supervisor, Agent menus exist
const qmHumanEvaluation = resolveQmHumanEvaluation(process.env);
console.log(
  JSON.stringify({
    event: 'qm.human_evaluation.readiness',
    status: qmHumanEvaluation ? 'ENABLED' : 'DISABLED',
  }),
);
console.log(
  JSON.stringify({
    event: 'recording.supervisor_playback.readiness',
    status: recordingSupervisorPlayback ? 'ENABLED' : 'DISABLED',
  }),
);
const governanceExportStorage = new S3GovernanceExportStorage();
const qmJobPublisher = new KafkaQmJobPublisher();
const journeyEventInbox = new EventInboxService(prisma);
/**
 * S2.5 (#369): the singleton webhook binding of the pilot — every value comes from the deployment config
 * not from the request body; no binding = the route rejects every request with a signature that fails verification
 */
// S2.6b (#403): the secret no longer comes from env — env can choose only the mode (#362 §9) and the Keychain is read at boot
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
// J5.5: the feature flag comes from the env kill switch (default off) AND the tenant's rollout row inside the repository
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
// E1.9 (#483): work-session lease — #583: enforced for every tenant (no flag any more)
const leaseSignals: { forward?: WorkspaceSessionWebSocketAdapter } = {};
// E1.11 (#485): allowlist for dphone embedding — localhost only in dev (not production)
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
// E1.17 (#519): the IAM VIEW scope is the authority for screen-pop; deny/stale/revoked still fail closed
const screenPop = new ScreenPopService(prisma, {
  hostOriginOfLease: (actor, leaseId) => workSessionLeases.embeddedHostOrigin(actor, leaseId),
  screenPopLevel: (tenantId, origin) => embedOrigins.screenPopLevel(tenantId, origin),
  disclosure: new ContactGovernanceDisclosureCheck(prisma, new IamTeamSegmentViewScope(prisma)),
});
const contactGovernance = new ContactGovernanceService(prisma);
const voiceRollout = new VoiceRolloutControlPlane(prisma);
const voiceOutcomeHandler = new VoiceTelephonyOutcomeHandler(
  new VoiceOriginateOutcomeProcessor(prisma, contactGovernance),
);
// E1.18 (#520): answer dialing only after the claim + durable transaction and only through the rollout authority
const clickToCall = new ClickToCallService(prisma, {
  hostOriginOfLease: (actor, leaseId) => workSessionLeases.embeddedHostOrigin(actor, leaseId),
  governance: contactGovernance,
  voiceDelivery: new VoiceOriginateDeliveryService(
    prisma,
    contactGovernance,
    recordingCommandPublisher,
    {
      enabled: process.env.OUTBOUND_VOICE_DELIVERY_ENABLED === 'true',
      rollout: voiceRollout,
    },
  ),
});
// Cus360 online authorization uses a separate confidential client; unset = disables only Cus360 work writes
// #916: report the status in the log at start so the customer panel does not vanish silently (incompletely set = throw)
const c360WorkConfig = resolveC360WorkConfig(process.env);
const c360WorkAuth = c360WorkConfig.configured
  ? new C360WorkAuthService(
      prisma,
      verifier,
      new KeycloakC360TokenIntrospector({
        issuer: required('KEYCLOAK_ISSUER'),
        clientId: c360WorkConfig.clientId,
        clientSecret: c360WorkConfig.clientSecret,
      }),
    )
  : undefined;
const c360WriteRuntime = createC360WriteRuntime();
const c360WorkStatus = c360WorkReadiness(c360WorkConfig, c360WriteRuntime.ready);
(c360WorkStatus.status === 'ENABLED' ? console.log : console.warn)(JSON.stringify(c360WorkStatus));
// #954: the External customer API is off by default; create needs an introspection client to work
const c360ServiceApi = resolveC360ServiceApiEnabled(process.env)
  ? new Customer360ServiceApi(
      prisma,
      c360SearchLimiter,
      c360WriteRuntime,
      c360WorkConfig.configured
        ? new KeycloakC360TokenIntrospector({
            issuer: required('KEYCLOAK_ISSUER'),
            clientId: c360WorkConfig.clientId,
            clientSecret: c360WorkConfig.clientSecret,
          })
        : null,
    )
  : undefined;
console.log(
  JSON.stringify(c360ServiceApiReadiness(c360ServiceApi !== undefined, c360WorkConfig.configured)),
);
const socketAdapter = new WorkspaceSessionWebSocketAdapter(
  gateway,
  tenantScope,
  { write: (diagnostic) => console.log(JSON.stringify(diagnostic)) },
  workSessionLeases,
  c360WorkAuth,
);
leaseSignals.forward = socketAdapter;
// release leases dropped while idle beyond the TTL (presence → OFFLINE); every instance can run it because the row is locked before closing
// a failed round (e.g. P2028 when the DB is slow) is logged and waits for the next round — it does not kill the process
startBackgroundLoop({
  name: 'work_session.sweep',
  intervalMs: 15_000,
  work: () => workSessionLeases.sweep(),
});
supervisorLiveEvents.subscribe(async (event, recipientUserIds) => {
  await socketAdapter.deliverLiveEvent(event, recipientUserIds);
});
// #1044: off by default; when on, the widget, Agent and settings routes exist and chats are moved along in the background
const webchatEnabled = resolveWebchat(process.env);
console.log(
  JSON.stringify({ event: 'webchat.readiness', status: webchatEnabled ? 'ENABLED' : 'DISABLED' }),
);
const webchatHub = new WebchatHub();
const webchat = new WebchatService(prisma, webchatHub);
if (webchatEnabled) {
  // the socket carries only "your chats changed"; the Workspace reads them again over HTTP
  webchatHub.onAgents((tenantId, agentIds) => {
    void socketAdapter
      .deliverLiveEvent({ type: 'webchat.changed', tenantId }, agentIds)
      .catch(() => undefined);
  });
  void webchat.discover().catch(() => undefined);
  startBackgroundLoop({
    name: 'webchat.discover',
    intervalMs: 30_000,
    work: () => webchat.discover(),
  });
  startBackgroundLoop({ name: 'webchat.round', intervalMs: 1_000, work: () => webchat.tickAll() });
}
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
    TenantCoreSettingsController,
    Customer360Controller,
    Customer360ImportController,
    Customer360TagCatalogController,
    Customer360OperatorController,
    Customer360ReadController,
    Customer360WorkController,
    Customer360OverviewController,
    Customer360ActivityController,
    TenantVoiceCatalogController,
    TenantPeopleController,
    WorkspaceSessionController,
    QueueController,
    TenantQueuePolicyController,
    VoiceDestinationController,
    QueueAuditController,
    SupervisorLiveController,
    RecordingController,
    RecordingPlaybackController,
    QmController,
    QmEvaluationController,
    AgentWorkspaceController,
    AgentCasesController,
    TeamHistoryController,
    TeamSegmentScopeController,
    FreeSwitchDirectoryController,
    WorkSessionController,
    EmbedOriginsController,
    AccountPolicyController,
    AccountController,
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
    ...(webchatEnabled
      ? [WebchatPublicController, WebchatAgentController, WebchatWidgetController]
      : []),
  ],
  providers: [
    { provide: CUSTOMER_360_WORK_AUTH, useValue: c360WorkAuth ?? null },
    { provide: TENANT_CORE_DATABASE, useValue: prisma },
    { provide: CUSTOMER_360_DATABASE, useValue: prisma },
    { provide: CUSTOMER_360_TAG_RUNTIME, useValue: createC360TagCatalogRuntime() },
    { provide: CUSTOMER_360_WRITE_RUNTIME, useValue: c360WriteRuntime },
    {
      provide: AGENT_WORKSPACE_CUSTOMER_AVAILABLE,
      useValue: c360WorkStatus.status === 'ENABLED',
    },
    { provide: CUSTOMER_360_SEARCH_LIMITER, useValue: c360SearchLimiter },
    ...(c360ServiceApi ? [{ provide: CUSTOMER_360_SERVICE_API, useValue: c360ServiceApi }] : []),
    { provide: TENANT_VOICE_DATABASE, useValue: prisma },
    {
      provide: TENANT_PEOPLE_READINESS,
      useFactory: () =>
        configuredPeopleRuntime(process.env, {
          flush: (registration) =>
            recordingCommandPublisher.publish({
              tenantId: registration.tenantId,
              command: {
                type: 'sip.registration.flush',
                vendor: 'freeswitch',
                telephonyNodeId: registration.telephonyNodeId,
                extension: registration.extension,
                sipDomain: registration.sipDomain,
                workSessionLeaseId: registration.workSessionLeaseId,
              },
            }),
        }),
    },
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
    { provide: TEAM_HISTORY_DATABASE, useValue: prisma },
    { provide: TELEPHONY_COMMAND_PUBLISHER, useValue: recordingCommandPublisher },
    { provide: RECORDING_STORAGE, useValue: recordingStorage },
    { provide: RECORDING_PLAYBACK_STORAGE, useValue: recordingStorage },
    { provide: RECORDING_SUPERVISOR_PLAYBACK, useValue: recordingSupervisorPlayback },
    { provide: QM_DATABASE, useValue: prisma },
    { provide: QM_EVALUATION_DATABASE, useValue: prisma },
    { provide: QM_HUMAN_EVALUATION, useValue: qmHumanEvaluation },
    { provide: QM_JOB_PUBLISHER, useValue: qmJobPublisher },
    { provide: AGENT_WORKSPACE_DATABASE, useValue: prisma },
    { provide: AGENT_CASES_DATABASE, useValue: prisma },
    { provide: AGENT_WORKSPACE_WEBCHAT, useValue: webchatEnabled },
    { provide: TEAM_HISTORY_WEBCHAT, useValue: webchatEnabled },
    { provide: WEBCHAT_SERVICE, useValue: webchat },
    { provide: WEBCHAT_DATABASE, useValue: prisma },
    { provide: WEBCHAT_WIDGET_DIR, useFactory: defaultWebchatWidgetDir },
    { provide: TEAM_SEGMENT_SCOPE_DATABASE, useValue: prisma },
    { provide: WORK_SESSION_LEASES, useValue: workSessionLeases },
    { provide: EMBED_ORIGIN_SERVICE, useValue: embedOrigins },
    // AC1 (#594): the tenant account policy — the 2FA enforcement port arrives in AC2 (#595); before that enabling 2FA gives 409
    { provide: ACCOUNT_POLICY_SERVICE, useValue: accountPolicies },
    { provide: ACCOUNT_SELF_SERVICE, useValue: accountSelfService },
    // E1.15 (#489): a versioned/alias `<dphone-launcher>` on the dphone origin
    { provide: DPHONE_LAUNCHER_OPTIONS, useValue: { releasesDir: defaultLauncherReleasesDir() } },
    { provide: SCREEN_POP_SERVICE, useValue: screenPop },
    { provide: CLICK_TO_CALL_SERVICE, useValue: clickToCall },
    {
      provide: DPHONE_EMBED_SHELL_OPTIONS,
      useValue: {
        // a separate Vite entry for embed in apps/workspace (dev = the vite dev server)
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
  // rawBody: the LINE signature is computed over the bytes actually received; re-serializing then verifying fails (#359 §B)
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
  await createConsumer<TelephonyCallEvent>({
    clientId: 'dcontact-api-voice-delivery',
    groupId: 'dcontact-api-voice-delivery-v1',
    topics: [KAFKA_TOPICS.TELEPHONY_EVENTS],
    idempotency: createInMemoryIdempotencyStore(),
    handler: async ({ event }) => {
      await voiceOutcomeHandler.handle(event);
    },
  });
  // #911: system segments → IAM projection; starts without blocking the API and can fail on its own while the API keeps working
  startC360SegmentWorker({ database: prisma });
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();

import 'reflect-metadata';
import { UnauthorizedException, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import {
  E1SandboxVoiceRollout,
  VoiceOriginateDeliveryService,
  VoiceRolloutControlPlane,
} from '@d-contact/delivery';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  CachedTenantLifecycleGate,
  KeycloakAccessTokenVerifier,
  WorkspaceSessionGateway,
  WorkspaceSessionRegistry,
  WorkspaceSessionWebSocketAdapter,
} from '@d-contact/workspace-session';
import {
  AGENT_SIP_CREDENTIALS,
  FreeSwitchDirectoryController,
  configuredAgentSipCredentialService,
} from './agent-sip-credentials.js';
import { AGENT_WORKSPACE_DATABASE, AgentWorkspaceController } from './agent-workspace-api.js';
import { CLICK_TO_CALL_SERVICE, ClickToCallController } from './click-to-call-api.js';
import { ClickToCallService } from './click-to-call.js';
import { E1VoiceCommandPublisher } from './e1-voice-command-publisher.js';
import { DphoneAuthCallbackController } from './dphone-auth-callback.js';
import {
  DPHONE_LAUNCHER_OPTIONS,
  DphoneLauncherController,
  defaultLauncherReleasesDir,
} from './dphone-launcher-api.js';
import {
  DPHONE_EMBED_SHELL_OPTIONS,
  DphoneEmbedController,
  EMBED_ORIGIN_SERVICE,
  EmbedOriginsController,
} from './embed-origins-api.js';
import { EmbedOriginService } from './embed-origins.js';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  TENANT_LIFECYCLE,
  OidcGlobalGuard,
  type GatewayDiagnosticSink,
} from './gateway-auth.js';
import { SCREEN_POP_SERVICE, ScreenPopController } from './screen-pop-api.js';
import {
  ContactGovernanceDisclosureCheck,
  IamTeamSegmentViewScope,
  ScreenPopService,
} from './screen-pop.js';
import {
  RuntimeProfileRouteGuard,
  assertEntrypointProfile,
  type ApiRuntimeProfile,
} from './runtime-profile.js';
import {
  RUNTIME_PROFILE_STATUS,
  RuntimeProfileController,
  type RuntimeProfileStatus,
} from './uat-api.js';
import { WORK_SESSION_LEASES, WorkSessionController } from './work-session-api.js';
import { WorkSessionLeases } from './work-session.js';
import { attachWorkspaceSessionWebSocket } from './workspace-session-websocket.js';

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export interface E1UatApiDependencies {
  database: PrismaClient;
  verifier: unknown;
  diagnostics: GatewayDiagnosticSink;
  lifecycle: unknown;
  status: RuntimeProfileStatus;
  embedOrigins: EmbedOriginService;
  leases: WorkSessionLeases;
  screenPop: ScreenPopService;
  clickToCall: ClickToCallService;
  sipCredentials: unknown;
  shellOptions: unknown;
}

export class E1UatApiModule {}

export function createE1UatApiModule(dependencies: E1UatApiDependencies): DynamicModule {
  return {
    module: E1UatApiModule,
    controllers: [
      RuntimeProfileController,
      EmbedOriginsController,
      DphoneEmbedController,
      DphoneLauncherController,
      DphoneAuthCallbackController,
      WorkSessionController,
      AgentWorkspaceController,
      ScreenPopController,
      ClickToCallController,
      FreeSwitchDirectoryController,
    ],
    providers: [
      { provide: RUNTIME_PROFILE_STATUS, useValue: dependencies.status },
      { provide: EMBED_ORIGIN_SERVICE, useValue: dependencies.embedOrigins },
      { provide: WORK_SESSION_LEASES, useValue: dependencies.leases },
      { provide: AGENT_WORKSPACE_DATABASE, useValue: dependencies.database },
      { provide: AGENT_SIP_CREDENTIALS, useValue: dependencies.sipCredentials },
      { provide: SCREEN_POP_SERVICE, useValue: dependencies.screenPop },
      { provide: CLICK_TO_CALL_SERVICE, useValue: dependencies.clickToCall },
      { provide: DPHONE_LAUNCHER_OPTIONS, useValue: { releasesDir: defaultLauncherReleasesDir() } },
      { provide: DPHONE_EMBED_SHELL_OPTIONS, useValue: dependencies.shellOptions },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: dependencies.verifier },
      { provide: GATEWAY_DIAGNOSTICS, useValue: dependencies.diagnostics },
      { provide: TENANT_LIFECYCLE, useValue: dependencies.lifecycle },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  };
}

export async function bootstrapE1UatApi(environment: NodeJS.ProcessEnv = process.env) {
  const profile: ApiRuntimeProfile = assertEntrypointProfile('uat-e1', environment);
  const diagnostics = { write: (event: object) => console.log(JSON.stringify(event)) };
  const routeGuard = new RuntimeProfileRouteGuard(profile, diagnostics);
  const database = new PrismaClient();
  const verifier = new KeycloakAccessTokenVerifier({
    issuer: required(environment, 'KEYCLOAK_ISSUER'),
    audience: required(environment, 'KEYCLOAK_AUDIENCE'),
    jwksUri: required(environment, 'KEYCLOAK_JWKS_URI'),
  });
  const lifecycle = new CachedTenantLifecycleGate((tenantId) =>
    database.tenant
      .findUnique({ where: { id: tenantId }, select: { lifecycleStatus: true } })
      .then((tenant) => tenant?.lifecycleStatus),
  );
  const gateway = new WorkspaceSessionGateway(verifier, new WorkspaceSessionRegistry(), lifecycle);
  const socketRef: { current?: WorkspaceSessionWebSocketAdapter } = {};
  const embedOrigins = new EmbedOriginService(database, {
    allowLocalhost: false,
    reservedOrigins: (environment.DCONTACT_RESERVED_ORIGINS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    revocations: {
      revoked: (tenantId, origin) =>
        void socketRef.current?.notifyEmbedOriginRevoked(tenantId, origin),
    },
  });
  const leases = new WorkSessionLeases(database, {
    embedOrigins,
    diagnostics,
    signals: {
      signal: (tenantId, userId, signal) =>
        void socketRef.current?.signalLease(tenantId, userId, signal),
    },
    sipRegistrations: {
      flush: (registration) =>
        diagnostics.write({
          event: 'e1_uat.sip_registration_flush_required',
          tenantId: registration.tenantId,
          workSessionLeaseId: registration.workSessionLeaseId,
        }),
    },
  });
  const screenPop = new ScreenPopService(database, {
    hostOriginOfLease: (actor, leaseId) => leases.embeddedHostOrigin(actor, leaseId),
    screenPopLevel: (tenantId, origin) => embedOrigins.screenPopLevel(tenantId, origin),
    disclosure: new ContactGovernanceDisclosureCheck(
      database,
      new IamTeamSegmentViewScope(database),
    ),
  });
  const governance = new ContactGovernanceService(database);
  const clickToCall = new ClickToCallService(database, {
    hostOriginOfLease: (actor, leaseId) => leases.embeddedHostOrigin(actor, leaseId),
    governance,
    voiceDelivery: new VoiceOriginateDeliveryService(
      database,
      governance,
      new E1VoiceCommandPublisher(required(environment, 'E1_VOICE_COMMAND_SECRET')),
      {
        enabled: environment.OUTBOUND_VOICE_DELIVERY_ENABLED === 'true',
        rollout: new E1SandboxVoiceRollout(new VoiceRolloutControlPlane(database), {
          tenantId: required(environment, 'E1_VOICE_TENANT_ID'),
          telephonyNodeId: 'e1-uat-sandbox',
        }),
      },
    ),
  });
  const module = createE1UatApiModule({
    database,
    verifier,
    diagnostics,
    lifecycle,
    status: {
      profile,
      routeGuard,
      journeyAuthoring: { canvasWrite: false, publishUi: false },
    },
    embedOrigins,
    leases,
    screenPop,
    clickToCall,
    sipCredentials: configuredAgentSipCredentialService(database, environment),
    shellOptions: {
      scriptUrl: required(environment, 'DPHONE_EMBED_SCRIPT_URL'),
      connectSrc: (environment.DPHONE_EMBED_CONNECT_SRC ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      auth: {
        issuer: required(environment, 'KEYCLOAK_ISSUER'),
        clientId: environment.DPHONE_EMBEDDED_CLIENT_ID ?? 'dphone-embedded',
      },
    },
  });
  const app = await NestFactory.create(module);
  app.use(routeGuard.middleware);
  const tenantScope = <T>(tenantId: string, work: () => Promise<T> | T): Promise<T> =>
    withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
      const tenant = await transaction.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true },
      });
      if (!tenant) throw new UnauthorizedException('tenant context is not provisioned');
      return work();
    });
  const socketAdapter = new WorkspaceSessionWebSocketAdapter(
    gateway,
    tenantScope,
    diagnostics,
    leases,
  );
  socketRef.current = socketAdapter;
  attachWorkspaceSessionWebSocket(app.getHttpServer(), socketAdapter);
  setInterval(() => void leases.sweep(), 15_000).unref();
  await app.listen(Number(environment.PORT ?? 3000));
}

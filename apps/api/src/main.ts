import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Controller, Module, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { EventInboxService } from '@d-contact/journey';
import { createConsumer, createInMemoryIdempotencyStore } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import {
  KeycloakAccessTokenVerifier,
  WorkspaceSessionGateway,
  WorkspaceSessionHttpAdapter,
  WorkspaceSessionRegistry,
  WorkspaceSessionWebSocketAdapter,
} from '@d-contact/workspace-session';
import { createWorkspaceSessionHandler } from './workspace-session-api.js';
import { attachWorkspaceSessionWebSocket } from './workspace-session-websocket.js';
import {
  GATEWAY_DIAGNOSTICS,
  GatewayRoles,
  OIDC_ACCESS_TOKEN_VERIFIER,
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
import { MinioRecordingStorage } from './minio-recording-storage.js';
import { QmController, QM_DATABASE, QM_JOB_PUBLISHER } from './qm-api.js';
import { KafkaQmJobPublisher } from './qm-job-publisher.js';
import {
  AgentWorkspaceController,
  AGENT_SIP_LEASE_PROVIDER,
  AGENT_WORKSPACE_DATABASE,
  configuredAgentSipLeaseProvider,
} from './agent-workspace-api.js';
import { JOURNEY_EVENT_INBOX, JourneyEventController } from './journey-event-api.js';
import {
  CONTACT_GOVERNANCE_DATABASE,
  ContactGovernanceCallbackRequestsController,
  ContactGovernanceContactQueryController,
  ContactGovernanceDecisionQueryController,
  ContactGovernancePoliciesController,
  ContactGovernancePreferencesController,
} from './contact-governance-api.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const prisma = new PrismaClient();
const verifier = new KeycloakAccessTokenVerifier({
  issuer: required('KEYCLOAK_ISSUER'),
  audience: required('KEYCLOAK_AUDIENCE'),
  jwksUri: required('KEYCLOAK_JWKS_URI'),
});
const gateway = new WorkspaceSessionGateway(verifier, new WorkspaceSessionRegistry());
const supervisorLiveEvents = new SupervisorLiveEventStream();
const recordingCommandPublisher = new KafkaTelephonyCommandPublisher();
const recordingStorage = new MinioRecordingStorage();
const qmJobPublisher = new KafkaQmJobPublisher();
const journeyEventInbox = new EventInboxService(prisma);
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
const socketAdapter = new WorkspaceSessionWebSocketAdapter(gateway, tenantScope, {
  write: (diagnostic) => console.log(JSON.stringify(diagnostic)),
});
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
    JourneyEventController,
    ContactGovernancePreferencesController,
    ContactGovernanceCallbackRequestsController,
    ContactGovernancePoliciesController,
    ContactGovernanceContactQueryController,
    ContactGovernanceDecisionQueryController,
  ],
  providers: [
    { provide: TENANT_QUEUE_DATABASE, useValue: prisma },
    { provide: CONTACT_GOVERNANCE_DATABASE, useValue: prisma },
    { provide: SUPERVISOR_LIVE_DATABASE, useValue: prisma },
    { provide: SupervisorLiveEventStream, useValue: supervisorLiveEvents },
    { provide: RECORDING_DATABASE, useValue: prisma },
    { provide: TELEPHONY_COMMAND_PUBLISHER, useValue: recordingCommandPublisher },
    { provide: RECORDING_STORAGE, useValue: recordingStorage },
    { provide: QM_DATABASE, useValue: prisma },
    { provide: QM_JOB_PUBLISHER, useValue: qmJobPublisher },
    { provide: AGENT_WORKSPACE_DATABASE, useValue: prisma },
    { provide: AGENT_SIP_LEASE_PROVIDER, useValue: configuredAgentSipLeaseProvider() },
    { provide: JOURNEY_EVENT_INBOX, useValue: journeyEventInbox },
    { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier },
    { provide: GATEWAY_DIAGNOSTICS, useValue: diagnostics },
    { provide: APP_GUARD, useClass: OidcGlobalGuard },
  ],
})
class AppModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: process.env.WORKSPACE_ORIGIN ?? 'http://localhost:5173',
    allowedHeaders: ['authorization', 'content-type', 'x-correlation-id', 'idempotency-key'],
    exposedHeaders: ['x-correlation-id', 'etag'],
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

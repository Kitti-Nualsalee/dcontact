/**
 * Owner: API bootstrap — the composition root of the UAT first slice (U1.2 #430)
 *
 * Authority: Phase Contract #374 (the `apps/journey` worker is not deployed; the API UAT profile closes Kafka/LINE/egress),
 * boundary #378
 *
 * deliberately different from `main.ts`: this file never imports/creates a Kafka consumer/publisher, LINE webhook ingress,
 * Redis, recording storage, telephony or workspace session, so there is no way to cause an external side effect even if the config
 * is wrong; the only object storage it can touch is the private UAT evidence bucket through `uat-evidence-storage.ts`
 * (U1.5 #433: screenshots stay in the UAT stack, 90-day retention, no public/presigned URL)
 * the controllers mounted are only Journey authoring/template (unilateral publish has no HTTP route), the UAT run
 * (U1.1 #429), run evidence (U1.5 #433) and the profile report; the Journey of a closed run is frozen by
 * `UatJourneyWriteGuard`
 */
import 'reflect-metadata';
import { Controller, Get, Inject, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import { IamJourneyAuthoringAuthorizer } from '@d-contact/iam';
import {
  JourneyTemplateRepository,
  UatEvidenceRepository,
  UatJourneyWriteGuard,
  UatRunRepository,
  journeyAuthoringFlagsFromEnvironment,
  type JourneyAuthoringFeatureFlags,
} from '@d-contact/journey';
import {
  CachedTenantLifecycleGate,
  KeycloakAccessTokenVerifier,
  type TenantLifecycleGate,
} from '@d-contact/workspace-session';
import {
  GATEWAY_DIAGNOSTICS,
  GatewayPublic,
  OIDC_ACCESS_TOKEN_VERIFIER,
  TENANT_LIFECYCLE,
  OidcGlobalGuard,
  type GatewayDiagnosticSink,
} from './gateway-auth.js';
import {
  JOURNEY_AUTHORING_REPOSITORY,
  JourneyAuthoringController,
} from './journey-authoring-api.js';
import { JourneyTemplateController } from './journey-template-api.js';
import { UAT_EVIDENCE_REPOSITORY, UatEvidenceController } from './uat-evidence-api.js';
import { UatEvidenceObjectStorage } from './uat-evidence-storage.js';
import { UAT_RUN_REPOSITORY, UatRunController } from './uat-run-api.js';
import {
  RuntimeProfileRouteGuard,
  assertEntrypointProfile,
  type ApiRuntimeProfile,
} from './runtime-profile.js';

export const RUNTIME_PROFILE_STATUS = Symbol('RUNTIME_PROFILE_STATUS');

export interface RuntimeProfileStatus {
  profile: ApiRuntimeProfile;
  routeGuard: RuntimeProfileRouteGuard;
  journeyAuthoring: JourneyAuthoringFeatureFlags;
}

/**
 * profile readiness — no login needed since smoke/readiness (#434) must be readable before accounts exist
 * returns only the guard and flag status, with no secret, tenant or config value
 */
@Controller('api/v1/runtime-profile')
export class RuntimeProfileController {
  constructor(@Inject(RUNTIME_PROFILE_STATUS) private readonly status: RuntimeProfileStatus) {}

  @Get()
  @GatewayPublic()
  read() {
    const { profile, routeGuard, journeyAuthoring } = this.status;
    return {
      profile: profile.name,
      kafka: profile.kafka,
      lineWebhook: profile.lineWebhook,
      providerEgress: profile.providerEgress,
      journeyRuntime: 'NOT_DEPLOYED',
      unilateralPublish: 'NOT_EXPOSED',
      blockedRequests: routeGuard.blockedRequests(),
      journeyAuthoring: {
        canvasWrite: journeyAuthoring.canvasWrite,
        publishUi: journeyAuthoring.publishUi,
      },
    };
  }
}

export interface UatApiDependencies {
  repository: unknown;
  uatRuns: unknown;
  /** U1.5 (#433): screenshot evidence/scan/bundle of the run */
  uatEvidence: unknown;
  verifier: unknown;
  diagnostics: GatewayDiagnosticSink;
  /** A1.8a (#447): the tenant must be ACTIVE before the UAT API can be used */
  lifecycle: TenantLifecycleGate;
  status: RuntimeProfileStatus;
}

export class UatApiModule {}

/** the UAT module — separated from bootstrap so tests can compose it with a fake repository/verifier */
export function createUatApiModule(dependencies: UatApiDependencies): DynamicModule {
  return {
    module: UatApiModule,
    controllers: [
      JourneyAuthoringController,
      JourneyTemplateController,
      UatRunController,
      UatEvidenceController,
      RuntimeProfileController,
    ],
    providers: [
      { provide: JOURNEY_AUTHORING_REPOSITORY, useValue: dependencies.repository },
      { provide: UAT_RUN_REPOSITORY, useValue: dependencies.uatRuns },
      { provide: UAT_EVIDENCE_REPOSITORY, useValue: dependencies.uatEvidence },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: dependencies.verifier },
      { provide: GATEWAY_DIAGNOSTICS, useValue: dependencies.diagnostics },
      { provide: TENANT_LIFECYCLE, useValue: dependencies.lifecycle },
      { provide: RUNTIME_PROFILE_STATUS, useValue: dependencies.status },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function bootstrapUatApi(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const profile = assertEntrypointProfile('uat', environment);
  const log = { write: (diagnostic: object) => console.log(JSON.stringify(diagnostic)) };
  const routeGuard = new RuntimeProfileRouteGuard(profile, log);
  const prisma = new PrismaClient();
  const journeyAuthoring = journeyAuthoringFlagsFromEnvironment(environment);
  const authoring = new JourneyTemplateRepository(prisma, {
    authorization: new IamJourneyAuthoringAuthorizer(),
    evaluator: new DcExprEvaluator(),
    flags: journeyAuthoring,
    writeGuard: new UatJourneyWriteGuard(),
  });
  // the evidence bucket must be ready (private + 90-day lifecycle) before accepting requests — not ready = the boot fails
  const evidenceStorage = UatEvidenceObjectStorage.fromEnvironment(environment);
  await evidenceStorage.ensureBucket();
  const module = createUatApiModule({
    repository: authoring,
    uatRuns: new UatRunRepository(prisma, authoring),
    uatEvidence: new UatEvidenceRepository(prisma, evidenceStorage),
    verifier: new KeycloakAccessTokenVerifier({
      issuer: required('KEYCLOAK_ISSUER'),
      audience: required('KEYCLOAK_AUDIENCE'),
      jwksUri: required('KEYCLOAK_JWKS_URI'),
    }),
    diagnostics: log,
    lifecycle: new CachedTenantLifecycleGate((tenantId) =>
      prisma.tenant
        .findUnique({ where: { id: tenantId }, select: { lifecycleStatus: true } })
        .then((tenant) => tenant?.lifecycleStatus),
    ),
    status: { profile, routeGuard, journeyAuthoring },
  });
  // the Console and the API are same-origin in UAT (#373), so CORS is not enabled
  const app = await NestFactory.create(module);
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

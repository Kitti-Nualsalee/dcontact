/**
 * Owner: API bootstrap — composition root ของ UAT first slice (U1.2 #430)
 *
 * Authority: Phase Contract #374 (ไม่ deploy `apps/journey` worker; API UAT profile ปิด Kafka/LINE/egress),
 * boundary #378
 *
 * ต่างจาก `main.ts` โดยตั้งใจ: ไฟล์นี้ไม่ import/สร้าง Kafka consumer/publisher, LINE webhook ingress,
 * Redis, MinIO, telephony หรือ workspace session เลย จึงไม่มีทางเกิด side effect ภายนอกแม้ config จะผิด
 * controller ที่ mount มีเฉพาะ Journey authoring/template (unilateral publish ไม่มี HTTP route) และรายงาน profile
 */
import 'reflect-metadata';
import { Controller, Get, Inject, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import { IamJourneyAuthoringAuthorizer } from '@d-contact/iam';
import {
  JourneyTemplateRepository,
  journeyAuthoringFlagsFromEnvironment,
  type JourneyAuthoringFeatureFlags,
} from '@d-contact/journey';
import { KeycloakAccessTokenVerifier } from '@d-contact/workspace-session';
import {
  GATEWAY_DIAGNOSTICS,
  GatewayPublic,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  type GatewayDiagnosticSink,
} from './gateway-auth.js';
import {
  JOURNEY_AUTHORING_REPOSITORY,
  JourneyAuthoringController,
} from './journey-authoring-api.js';
import { JourneyTemplateController } from './journey-template-api.js';
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
 * readiness ของ profile — ไม่ต้อง login เพราะ smoke/readiness (#434) ต้องอ่านได้ก่อนมีบัญชี
 * คืนเฉพาะสถานะของ guard และ flag ไม่มี secret, tenant หรือ config value
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
  verifier: unknown;
  diagnostics: GatewayDiagnosticSink;
  status: RuntimeProfileStatus;
}

export class UatApiModule {}

/** module ของ UAT — แยกจาก bootstrap เพื่อให้เทสต์ประกอบด้วย repository/verifier ปลอมได้ */
export function createUatApiModule(dependencies: UatApiDependencies): DynamicModule {
  return {
    module: UatApiModule,
    controllers: [JourneyAuthoringController, JourneyTemplateController, RuntimeProfileController],
    providers: [
      { provide: JOURNEY_AUTHORING_REPOSITORY, useValue: dependencies.repository },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: dependencies.verifier },
      { provide: GATEWAY_DIAGNOSTICS, useValue: dependencies.diagnostics },
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
  const module = createUatApiModule({
    repository: new JourneyTemplateRepository(prisma, {
      authorization: new IamJourneyAuthoringAuthorizer(),
      evaluator: new DcExprEvaluator(),
      flags: journeyAuthoring,
    }),
    verifier: new KeycloakAccessTokenVerifier({
      issuer: required('KEYCLOAK_ISSUER'),
      audience: required('KEYCLOAK_AUDIENCE'),
      jwksUri: required('KEYCLOAK_JWKS_URI'),
    }),
    diagnostics: log,
    status: { profile, routeGuard, journeyAuthoring },
  });
  // Console กับ API อยู่ same-origin ใน UAT (#373) จึงไม่เปิด CORS
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

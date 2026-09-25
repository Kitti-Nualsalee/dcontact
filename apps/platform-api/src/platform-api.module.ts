import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import {
  PLATFORM_ACCESS_TOKEN_VERIFIER,
  PLATFORM_AUTH_DIAGNOSTICS,
  PLATFORM_CLOCK,
  PLATFORM_ROLLOUT,
  PlatformAuthGuard,
  PlatformErrorFilter,
  type PlatformAuthDiagnosticSink,
} from './platform-auth.js';
import { PlatformSessionController } from './platform-session.controller.js';
import {
  CatalogController,
  PLATFORM_SERVICES,
  ProvisioningRequestsController,
  TenantsController,
  type PlatformServices,
} from './provisioning.controller.js';
import type { PlatformAccessTokenVerifier } from './platform-verifier.js';
import type { PlatformRollout } from '@d-contact/platform-control';

export interface PlatformApiModuleOptions {
  verifier: PlatformAccessTokenVerifier;
  diagnostics: PlatformAuthDiagnosticSink;
  /** A1.8: `platformProvisioning.enabled` + canary allowlist — บังคับส่ง ไม่มีค่า default ที่เปิดไว้ */
  rollout: PlatformRollout;
  clock?: () => Date;
  /** controller เพิ่มเติม — อยู่ใต้ guard เดียวกันเสมอ */
  controllers?: Type[];
  /** A1.6: service ของ control plane (Prisma role `dcontact_platform`) — ไม่ส่งมา = ไม่มี provisioning routes */
  services?: PlatformServices;
}

@Module({})
export class PlatformApiModule {
  static register(options: PlatformApiModuleOptions): DynamicModule {
    return {
      module: PlatformApiModule,
      controllers: [
        PlatformSessionController,
        ...(options.services
          ? [ProvisioningRequestsController, TenantsController, CatalogController]
          : []),
        ...(options.controllers ?? []),
      ],
      providers: [
        { provide: PLATFORM_ACCESS_TOKEN_VERIFIER, useValue: options.verifier },
        { provide: PLATFORM_AUTH_DIAGNOSTICS, useValue: options.diagnostics },
        { provide: PLATFORM_CLOCK, useValue: options.clock ?? (() => new Date()) },
        { provide: PLATFORM_ROLLOUT, useValue: options.rollout },
        ...(options.services ? [{ provide: PLATFORM_SERVICES, useValue: options.services }] : []),
        { provide: APP_GUARD, useClass: PlatformAuthGuard },
        { provide: APP_FILTER, useClass: PlatformErrorFilter },
      ],
    };
  }
}

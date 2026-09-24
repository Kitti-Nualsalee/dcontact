import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import {
  PLATFORM_ACCESS_TOKEN_VERIFIER,
  PLATFORM_AUTH_DIAGNOSTICS,
  PLATFORM_CLOCK,
  PlatformAuthGuard,
  PlatformErrorFilter,
  type PlatformAuthDiagnosticSink,
} from './platform-auth.js';
import { PlatformSessionController } from './platform-session.controller.js';
import type { PlatformAccessTokenVerifier } from './platform-verifier.js';

export interface PlatformApiModuleOptions {
  verifier: PlatformAccessTokenVerifier;
  diagnostics: PlatformAuthDiagnosticSink;
  clock?: () => Date;
  /** controller เพิ่มเติม (เช่น provisioning API ของ A1.4) — อยู่ใต้ guard เดียวกันเสมอ */
  controllers?: Type[];
}

@Module({})
export class PlatformApiModule {
  static register(options: PlatformApiModuleOptions): DynamicModule {
    return {
      module: PlatformApiModule,
      controllers: [PlatformSessionController, ...(options.controllers ?? [])],
      providers: [
        { provide: PLATFORM_ACCESS_TOKEN_VERIFIER, useValue: options.verifier },
        { provide: PLATFORM_AUTH_DIAGNOSTICS, useValue: options.diagnostics },
        { provide: PLATFORM_CLOCK, useValue: options.clock ?? (() => new Date()) },
        { provide: APP_GUARD, useClass: PlatformAuthGuard },
        { provide: APP_FILTER, useClass: PlatformErrorFilter },
      ],
    };
  }
}

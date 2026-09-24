/**
 * สร้าง service ของ control plane จาก Prisma ที่ต่อด้วย role `dcontact_platform` เท่านั้น
 * (#387: Platform API ใช้ database role เฉพาะ control plane — ไม่มีสิทธิ์ business data)
 */
import type { PrismaClient } from '@d-contact/db';
import {
  OperatorCommandIntake,
  PlatformCatalog,
  PlatformQueries,
  ProvisioningControlRepository,
  ProvisioningRequestEditor,
} from '@d-contact/platform-control';
import type { PlatformServices } from './provisioning.controller.js';

export function createPlatformServices(
  database: PrismaClient,
  options: { sipBaseDomain: string; now?: () => Date },
): PlatformServices {
  const clock = options.now ? { now: options.now } : {};
  return {
    queries: new PlatformQueries(database),
    intake: new OperatorCommandIntake(database, clock),
    editor: new ProvisioningRequestEditor(database, clock),
    catalog: new PlatformCatalog(database),
    repository: new ProvisioningControlRepository(database, {
      sipBaseDomain: options.sipBaseDomain,
      ...clock,
    }),
  };
}

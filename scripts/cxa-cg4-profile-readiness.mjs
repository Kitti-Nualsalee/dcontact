import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * CG4-REG02/CG4-OB01 (#178): owner profile และ fixed flags ของ CG4 Development Complete
 *
 * Contact Governance ต้องเป็น durable owner จริง, Console เรียกเฉพาะ D-Contact API, CG3 ต้อง
 * integrated บน SHA เดียวกัน และไม่มี provider ใดเลย — flag ทั้งห้าคงค่าเสมอ ถ้า environment พยายาม
 * เปลี่ยนค่าใดให้ fail closed แทนการรายงานค่าที่ไม่ปลอดภัย
 */

export const CG4_FIXED_FLAGS = Object.freeze({
  developmentAcceptance: true,
  releaseEnabled: false,
  actualProviderTraffic: false,
  providerConformance: false,
  syntheticFixturesOnly: true,
});

export const CG4_OWNER_PROFILES = Object.freeze({
  contactGovernance: 'DURABLE_OWNER',
  console: 'D_CONTACT_API_ONLY',
  cg3: 'INTEGRATED_SAME_SHA',
  provider: 'NONE',
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function cxaCg4ProfileSummary(environment = process.env) {
  const profiles = {
    contactGovernance:
      environment.CXA_CG4_GOVERNANCE_PROFILE ?? CG4_OWNER_PROFILES.contactGovernance,
    console: environment.CXA_CG4_CONSOLE_PROFILE ?? CG4_OWNER_PROFILES.console,
    cg3: environment.CXA_CG4_CG3_PROFILE ?? CG4_OWNER_PROFILES.cg3,
    provider: environment.CXA_CG4_PROVIDER_PROFILE ?? CG4_OWNER_PROFILES.provider,
  };
  for (const [owner, expected] of Object.entries(CG4_OWNER_PROFILES)) {
    assert(
      profiles[owner] === expected,
      `CG4 acceptance ต้องการ ${owner} profile ${expected} เท่านั้น`,
    );
  }
  assert(
    environment.CXA_PROVIDER_TRAFFIC_ENABLED !== 'true',
    'CG4 acceptance ห้ามเปิด actual provider traffic',
  );
  assert(
    environment.CXA_CG4_RELEASE_ENABLED !== 'true',
    'CG4 development acceptance ห้ามอ้าง releaseEnabled',
  );
  assert(
    environment.CXA_CG4_PROVIDER_CONFORMANCE !== 'true',
    'CG4 development acceptance ห้ามอ้าง providerConformance',
  );
  assert(
    environment.CXA_CG4_REAL_CUSTOMER_DATA !== 'true',
    'CG4 development acceptance ใช้ synthetic fixture เท่านั้น',
  );
  return {
    type: 'owner-profile.readiness',
    workflow: 'cxa-cg4-owner-profile',
    status: 'PASS',
    profiles,
    flags: { ...CG4_FIXED_FLAGS },
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    process.stdout.write(`CXA_CG4_PROFILE_EVIDENCE:${JSON.stringify(cxaCg4ProfileSummary())}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

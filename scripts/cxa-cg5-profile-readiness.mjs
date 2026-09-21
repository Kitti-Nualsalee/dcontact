import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * CG5-REG02/CG5-OB02 (#273 §5): owner profile และ fixed flags ของ CG5 Development Complete
 *
 * marker ไม่ได้เปิดอะไรให้ใครใช้: external API และ export ระดับ EVIDENCE เป็น gate แยกราย tenant/client
 * (#273 §6) — ถ้า environment พยายามเปลี่ยน flag ใดให้ fail closed แทนการรายงานค่าที่ไม่ปลอดภัย
 */

export const CG5_FIXED_FLAGS = Object.freeze({
  developmentAcceptance: true,
  releaseEnabled: false,
  actualProviderTraffic: false,
  externalApiEnabled: false,
  syntheticFixturesOnly: true,
});

export const CG5_OWNER_PROFILES = Object.freeze({
  contactGovernance: 'DURABLE_OWNER',
  readModel: 'CG_OWNED_PROJECTION',
  console: 'D_CONTACT_API_ONLY',
  externalApi: 'READ_ONLY_NOT_RELEASED',
  provider: 'NONE',
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function cxaCg5ProfileSummary(environment = process.env) {
  const profiles = {
    contactGovernance:
      environment.CXA_CG5_GOVERNANCE_PROFILE ?? CG5_OWNER_PROFILES.contactGovernance,
    readModel: environment.CXA_CG5_READ_MODEL_PROFILE ?? CG5_OWNER_PROFILES.readModel,
    console: environment.CXA_CG5_CONSOLE_PROFILE ?? CG5_OWNER_PROFILES.console,
    externalApi: environment.CXA_CG5_EXTERNAL_API_PROFILE ?? CG5_OWNER_PROFILES.externalApi,
    provider: environment.CXA_CG5_PROVIDER_PROFILE ?? CG5_OWNER_PROFILES.provider,
  };
  for (const [owner, expected] of Object.entries(CG5_OWNER_PROFILES)) {
    assert(
      profiles[owner] === expected,
      `CG5 acceptance ต้องการ ${owner} profile ${expected} เท่านั้น`,
    );
  }
  assert(
    environment.CXA_PROVIDER_TRAFFIC_ENABLED !== 'true',
    'CG5 acceptance ห้ามเปิด actual provider traffic',
  );
  assert(
    environment.CXA_CG5_RELEASE_ENABLED !== 'true',
    'CG5 development acceptance ห้ามอ้าง releaseEnabled',
  );
  assert(
    environment.CXA_CG5_EXTERNAL_API_ENABLED !== 'true',
    'CG5 development acceptance ห้ามเปิด external API ให้ client จริง (gate แยกตาม #273 §6)',
  );
  assert(
    environment.CXA_CG5_REAL_CUSTOMER_DATA !== 'true',
    'CG5 development acceptance ใช้ synthetic fixture เท่านั้น',
  );
  return {
    type: 'owner-profile.readiness',
    workflow: 'cxa-cg5-owner-profile',
    status: 'PASS',
    profiles,
    flags: { ...CG5_FIXED_FLAGS },
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    process.stdout.write(`CXA_CG5_PROFILE_EVIDENCE:${JSON.stringify(cxaCg5ProfileSummary())}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

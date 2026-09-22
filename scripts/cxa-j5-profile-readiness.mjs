import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * J5-OB01/J5-REG01 (#333 §6): owner profiles, environment profiles และ fixed flags ของ J5 Development
 * Acceptance — ค่าต้องตรงทุก key ห้าม caller override; ถ้า environment พยายามเปลี่ยนให้ fail closed
 */

export const J5_OWNER_PROFILES = Object.freeze({
  journey: 'DURABLE_OWNER',
  customer360: 'DURABLE_OWNER',
  cases: 'DURABLE_OWNER',
  dialer: 'DURABLE_OWNER',
  iam: 'TEST_ADAPTER',
  governance: 'CG3_INTEGRATED',
  delivery: 'TEST_ADAPTER',
  kafka: 'REDPANDA',
});

/** browser/database เป็น environment ไม่ใช่ domain owner จึงแยกออกมาไม่ให้ปลอมเป็น owner */
export const J5_ENVIRONMENT_PROFILES = Object.freeze({
  browser: 'PLAYWRIGHT_CHROMIUM',
  database: 'POSTGRES_RLS',
});

export const J5_FIXED_FLAGS = Object.freeze({
  developmentAcceptance: true,
  releaseEnabled: false,
  actualProviderTraffic: false,
  providerConformance: false,
  syntheticFixturesOnly: true,
});

const ENV_KEYS = Object.freeze({
  journey: 'CXA_J5_JOURNEY_PROFILE',
  customer360: 'CXA_J5_CUSTOMER360_PROFILE',
  cases: 'CXA_J5_CASES_PROFILE',
  dialer: 'CXA_J5_DIALER_PROFILE',
  iam: 'CXA_J5_IAM_PROFILE',
  governance: 'CXA_J5_GOVERNANCE_PROFILE',
  delivery: 'CXA_J5_DELIVERY_PROFILE',
  kafka: 'CXA_J5_KAFKA_PROFILE',
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function cxaJ5ProfileSummary(environment = process.env) {
  const profiles = Object.fromEntries(
    Object.entries(J5_OWNER_PROFILES).map(([owner, expected]) => [
      owner,
      environment[ENV_KEYS[owner]] ?? expected,
    ]),
  );
  for (const [owner, expected] of Object.entries(J5_OWNER_PROFILES)) {
    assert(
      profiles[owner] === expected,
      `J5 acceptance ต้องการ ${owner} profile ${expected} เท่านั้น`,
    );
  }
  assert(
    environment.CXA_PROVIDER_TRAFFIC_ENABLED !== 'true',
    'J5 acceptance ห้ามเปิด actual provider traffic',
  );
  assert(
    environment.CXA_J5_RELEASE_ENABLED !== 'true',
    'J5 development acceptance ห้ามอ้าง releaseEnabled',
  );
  assert(
    environment.CXA_J5_PROVIDER_CONFORMANCE !== 'true',
    'J5 development acceptance ไม่ใช่ provider conformance',
  );
  assert(
    environment.CXA_J5_REAL_CUSTOMER_DATA !== 'true',
    'J5 development acceptance ใช้ synthetic fixture เท่านั้น',
  );
  // flag ของ UI/publish ต้องเปิดผ่าน rollout row ของ tenant สังเคราะห์ในเทสต์ ไม่ใช่เปิดทั้ง environment
  for (const flag of [
    'J5_CANVAS_WRITE_ENABLED',
    'J5_PUBLISH_UI_ENABLED',
    'J5_TEMPLATE_CATALOG_ENABLED',
    'J5_TEMPLATE_UPGRADE_ENABLED',
  ]) {
    assert(environment[flag] !== 'true', `J5 acceptance ห้ามเปิด ${flag} ระดับ environment`);
  }
  return {
    type: 'owner-profile.readiness',
    workflow: 'cxa-j5-owner-profile',
    status: 'PASS',
    profiles,
    environmentProfiles: { ...J5_ENVIRONMENT_PROFILES },
    flags: { ...J5_FIXED_FLAGS },
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    process.stdout.write(`CXA_J5_PROFILE_EVIDENCE:${JSON.stringify(cxaJ5ProfileSummary())}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

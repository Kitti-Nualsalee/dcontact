import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const DURABLE_OWNER_PROFILE = 'DURABLE_OWNER';
const GOVERNANCE_PROFILES = new Set(['TEST_ADAPTER', 'CG3_INTEGRATED']);
const DELIVERY_PROFILE = 'TEST_ADAPTER';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * J2-OB01: Cases/Dialer ต้องเป็น canonical durable writer จริง (ไม่ใช่ fake/in-memory
 * ตาม #126 stop condition), Governance รับได้ทั้ง synthetic TEST_ADAPTER (ก่อน S1 merge)
 * และ CG3_INTEGRATED (บน target SHA จริง) โดยไม่เปลี่ยน C1 port, Delivery ยังเป็น
 * TEST_ADAPTER เท่านั้นเหมือน C1 — ทุก profile ต้องคง actualProviderTraffic=false
 */
export function cxaJ2ProfileSummary(environment = process.env) {
  const casesOwnerProfile = environment.CXA_J2_CASES_OWNER_PROFILE ?? DURABLE_OWNER_PROFILE;
  const dialerOwnerProfile = environment.CXA_J2_DIALER_OWNER_PROFILE ?? DURABLE_OWNER_PROFILE;
  const governanceProfile = environment.CXA_J2_GOVERNANCE_PROFILE ?? 'TEST_ADAPTER';
  const deliveryProfile = environment.CXA_J2_DELIVERY_PROFILE ?? DELIVERY_PROFILE;
  const providerTrafficEnabled = environment.CXA_PROVIDER_TRAFFIC_ENABLED === 'true';
  const providerConformanceEnabled = environment.CXA_J2_PROVIDER_CONFORMANCE === 'true';
  const releaseEnabled = environment.CXA_J2_RELEASE_ENABLED === 'true';

  assert(
    casesOwnerProfile === DURABLE_OWNER_PROFILE,
    `J2 acceptance ต้องการ Cases owner profile ${DURABLE_OWNER_PROFILE} เท่านั้น`,
  );
  assert(
    dialerOwnerProfile === DURABLE_OWNER_PROFILE,
    `J2 acceptance ต้องการ Dialer owner profile ${DURABLE_OWNER_PROFILE} เท่านั้น`,
  );
  assert(
    GOVERNANCE_PROFILES.has(governanceProfile),
    'J2 acceptance รองรับ governance profile TEST_ADAPTER หรือ CG3_INTEGRATED เท่านั้น',
  );
  assert(
    deliveryProfile === DELIVERY_PROFILE,
    `J2 acceptance ต้องการ delivery profile ${DELIVERY_PROFILE} เท่านั้น`,
  );
  assert(!providerTrafficEnabled, 'J2 acceptance ห้ามเปิด actual provider traffic');
  assert(!providerConformanceEnabled, 'J2 development acceptance ห้ามอ้าง providerConformance');
  assert(!releaseEnabled, 'J2 development acceptance ห้ามอ้าง releaseEnabled');

  return {
    type: 'owner-profile.readiness',
    workflow: 'cx-automation-j2-owner-profile',
    status: 'PASS',
    casesOwnerProfile,
    dialerOwnerProfile,
    governanceProfile,
    deliveryProfile,
    developmentAcceptance: true,
    actualProviderTraffic: false,
    providerConformance: false,
    releaseEnabled: false,
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    process.stdout.write(
      `CXA_J2_OWNER_PROFILE_EVIDENCE:${JSON.stringify(cxaJ2ProfileSummary())}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

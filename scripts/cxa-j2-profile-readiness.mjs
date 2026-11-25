import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const DURABLE_OWNER_PROFILE = 'DURABLE_OWNER';
const GOVERNANCE_PROFILES = new Set(['TEST_ADAPTER', 'CG3_INTEGRATED']);
const DELIVERY_PROFILE = 'TEST_ADAPTER';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * J2-OB01: Cases/Dialer must be a real canonical durable writer (not a fake/in-memory
 * per the #126 stop condition), Governance accepts either the synthetic TEST_ADAPTER (before the S1 merge)
 * or CG3_INTEGRATED (on the real target SHA) without changing the C1 port, and Delivery stays
 * TEST_ADAPTER only, like C1 - every profile must keep actualProviderTraffic=false
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
    `J2 acceptance needs the Cases owner profile ${DURABLE_OWNER_PROFILE} only`,
  );
  assert(
    dialerOwnerProfile === DURABLE_OWNER_PROFILE,
    `J2 acceptance needs the Dialer owner profile ${DURABLE_OWNER_PROFILE} only`,
  );
  assert(
    GOVERNANCE_PROFILES.has(governanceProfile),
    'J2 acceptance supports only the governance profile TEST_ADAPTER or CG3_INTEGRATED',
  );
  assert(
    deliveryProfile === DELIVERY_PROFILE,
    `J2 acceptance needs the delivery profile ${DELIVERY_PROFILE} only`,
  );
  assert(!providerTrafficEnabled, 'J2 acceptance must not enable actual provider traffic');
  assert(
    !providerConformanceEnabled,
    'J2 development acceptance must not claim providerConformance',
  );
  assert(!releaseEnabled, 'J2 development acceptance must not claim releaseEnabled');

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

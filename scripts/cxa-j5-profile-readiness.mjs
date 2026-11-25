import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * J5-OB01/J5-REG01 (#333 §6): owner profiles, environment profiles and fixed flags of J5 Development
 * Acceptance - every key must match, the caller cannot override; if the environment tries to change them, fail closed
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

/** browser/database are environment, not a domain owner, so they are kept separate so they cannot pose as an owner */
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
      `J5 acceptance needs the ${owner} profile ${expected} only`,
    );
  }
  assert(
    environment.CXA_PROVIDER_TRAFFIC_ENABLED !== 'true',
    'J5 acceptance must not enable actual provider traffic',
  );
  assert(
    environment.CXA_J5_RELEASE_ENABLED !== 'true',
    'J5 development acceptance must not claim releaseEnabled',
  );
  assert(
    environment.CXA_J5_PROVIDER_CONFORMANCE !== 'true',
    'J5 development acceptance is not provider conformance',
  );
  assert(
    environment.CXA_J5_REAL_CUSTOMER_DATA !== 'true',
    'J5 development acceptance uses synthetic fixtures only',
  );
  // the UI/publish flags must be enabled through the rollout row of a synthetic tenant in the test, not by enabling them for the whole environment
  for (const flag of [
    'J5_CANVAS_WRITE_ENABLED',
    'J5_PUBLISH_UI_ENABLED',
    'J5_TEMPLATE_CATALOG_ENABLED',
    'J5_TEMPLATE_UPGRADE_ENABLED',
  ]) {
    assert(
      environment[flag] !== 'true',
      `J5 acceptance must not enable ${flag} at the environment level`,
    );
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

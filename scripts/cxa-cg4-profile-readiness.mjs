import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * CG4-REG02/CG4-OB01 (#178): owner profile and fixed flags of CG4 Development Complete
 *
 * Contact Governance must be a real durable owner, Console calls only the D-Contact API, CG3 must be
 * integrated on the same SHA and there is no provider at all - all five flags stay fixed; if the environment tries to
 * change any value, fail closed instead of reporting an unsafe value
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
      `CG4 acceptance needs the ${owner} profile ${expected} only`,
    );
  }
  assert(
    environment.CXA_PROVIDER_TRAFFIC_ENABLED !== 'true',
    'CG4 acceptance must not enable actual provider traffic',
  );
  assert(
    environment.CXA_CG4_RELEASE_ENABLED !== 'true',
    'CG4 development acceptance must not claim releaseEnabled',
  );
  assert(
    environment.CXA_CG4_PROVIDER_CONFORMANCE !== 'true',
    'CG4 development acceptance must not claim providerConformance',
  );
  assert(
    environment.CXA_CG4_REAL_CUSTOMER_DATA !== 'true',
    'CG4 development acceptance uses synthetic fixtures only',
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

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const TEST_ADAPTER_PROFILE = 'TEST_ADAPTER';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * E0 allows only the test adapter; this acceptance must not be used as evidence that
 * provider traffic or a CG2/J1 production adapter is enabled.
 */
export function cxaE0AdapterProfileSummary(environment = process.env) {
  const adapterProfile = environment.CXA_E0_ADAPTER_PROFILE ?? TEST_ADAPTER_PROFILE;
  const providerTrafficEnabled = environment.CXA_PROVIDER_TRAFFIC_ENABLED === 'true';
  assert(
    adapterProfile === TEST_ADAPTER_PROFILE,
    `E0 acceptance supports only the ${TEST_ADAPTER_PROFILE} adapter profile`,
  );
  assert(!providerTrafficEnabled, 'E0 acceptance must not enable actual provider traffic');
  return {
    type: 'adapter-profile.readiness',
    workflow: 'cx-automation-e0-adapter-profile',
    status: 'PASS',
    adapterProfile,
    actualProviderTraffic: false,
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    process.stdout.write(
      `CXA_E0_ADAPTER_PROFILE_EVIDENCE:${JSON.stringify(cxaE0AdapterProfileSummary())}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

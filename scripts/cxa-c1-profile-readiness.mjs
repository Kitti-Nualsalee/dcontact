import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const TEST_ADAPTER_PROFILE = 'TEST_ADAPTER';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * C1 allows only the test adapter (apps/delivery), like E0; this acceptance must not be used as
 * evidence that real provider traffic or a production delivery adapter is enabled
 */
export function cxaC1AdapterProfileSummary(environment = process.env) {
  const adapterProfile = environment.CXA_C1_ADAPTER_PROFILE ?? TEST_ADAPTER_PROFILE;
  const providerTrafficEnabled = environment.CXA_PROVIDER_TRAFFIC_ENABLED === 'true';
  assert(
    adapterProfile === TEST_ADAPTER_PROFILE,
    `C1 acceptance supports only the ${TEST_ADAPTER_PROFILE} adapter profile`,
  );
  assert(!providerTrafficEnabled, 'C1 acceptance must not enable actual provider traffic');
  return {
    type: 'adapter-profile.readiness',
    workflow: 'cx-automation-c1-adapter-profile',
    status: 'PASS',
    adapterProfile,
    actualProviderTraffic: false,
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    process.stdout.write(
      `CXA_C1_ADAPTER_PROFILE_EVIDENCE:${JSON.stringify(cxaC1AdapterProfileSummary())}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

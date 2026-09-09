import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const TEST_ADAPTER_PROFILE = 'TEST_ADAPTER';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * E0 อนุญาตเฉพาะ test adapter; ห้าม acceptance นี้ถูกใช้เป็นหลักฐานว่า
 * provider traffic หรือ CG2/J1 production adapter เปิดใช้งานแล้ว.
 */
export function cxaE0AdapterProfileSummary(environment = process.env) {
  const adapterProfile = environment.CXA_E0_ADAPTER_PROFILE ?? TEST_ADAPTER_PROFILE;
  const providerTrafficEnabled = environment.CXA_PROVIDER_TRAFFIC_ENABLED === 'true';
  assert(
    adapterProfile === TEST_ADAPTER_PROFILE,
    `E0 acceptance รองรับ adapter profile ${TEST_ADAPTER_PROFILE} เท่านั้น`,
  );
  assert(!providerTrafficEnabled, 'E0 acceptance ห้ามเปิด actual provider traffic');
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

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/** #222: โปรไฟล์นี้เป็นหลักฐานของ owner boundary ไม่ใช่ feature flag ที่ caller เปลี่ยนได้ */
export const J3_FIXED_FLAGS = Object.freeze({
  developmentAcceptance: true,
  releaseEnabled: false,
  actualProviderTraffic: false,
  providerConformance: false,
  syntheticFixturesOnly: true,
});

export const J3_OWNER_PROFILES = Object.freeze({
  customer360: 'DURABLE_OWNER',
  journey: 'DURABLE_OWNER',
  iam: 'TEST_ADAPTER',
  governance: 'CG3_INTEGRATED',
  delivery: 'TEST_ADAPTER',
  kafka: 'REDPANDA',
});

export function cxaJ3ProfileSummary(environment = process.env) {
  const supplied = {
    customer360: environment.CXA_J3_CUSTOMER_360_PROFILE ?? J3_OWNER_PROFILES.customer360,
    journey: environment.CXA_J3_JOURNEY_PROFILE ?? J3_OWNER_PROFILES.journey,
    iam: environment.CXA_J3_IAM_PROFILE ?? J3_OWNER_PROFILES.iam,
    governance: environment.CXA_J3_GOVERNANCE_PROFILE ?? J3_OWNER_PROFILES.governance,
    delivery: environment.CXA_J3_DELIVERY_PROFILE ?? J3_OWNER_PROFILES.delivery,
    kafka: environment.CXA_J3_KAFKA_PROFILE ?? J3_OWNER_PROFILES.kafka,
  };
  for (const [owner, profile] of Object.entries(J3_OWNER_PROFILES)) {
    if (supplied[owner] !== profile) {
      throw new Error(`J3 acceptance ต้องการ ${owner} profile ${profile} เท่านั้น`);
    }
  }
  for (const name of [
    'CXA_PROVIDER_TRAFFIC_ENABLED',
    'CXA_J3_RELEASE_ENABLED',
    'CXA_J3_PROVIDER_CONFORMANCE',
    'CXA_J3_REAL_CUSTOMER_DATA',
  ]) {
    if (environment[name] === 'true') throw new Error(`J3 development acceptance ห้ามเปิด ${name}`);
  }
  return {
    type: 'owner-profile.readiness',
    workflow: 'cxa-j3-owner-profile',
    status: 'PASS',
    profiles: supplied,
    flags: { ...J3_FIXED_FLAGS },
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    process.stdout.write(`CXA_J3_PROFILE_EVIDENCE:${JSON.stringify(cxaJ3ProfileSummary())}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

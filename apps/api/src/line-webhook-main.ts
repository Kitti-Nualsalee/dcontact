/**
 * Entrypoint of the `line-webhook` service on UAT (#565, ADR-031) — `DCONTACT_API_PROFILE=uat-line` must be set
 * otherwise the boot fails; the UAT API is `uat-main.ts`
 */
import { bootstrapLineWebhook } from './line-webhook-app.js';

void bootstrapLineWebhook().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'api.runtime_profile.boot_failed',
      error: error instanceof Error ? error.message : 'unknown',
    }),
  );
  process.exit(1);
});

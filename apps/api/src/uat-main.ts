/**
 * Entrypoint of the API in the UAT first slice (U1.2 #430) — `DCONTACT_API_PROFILE=uat` must be set
 * otherwise the boot fails; the composition root of other profiles is `main.ts`
 */
import { bootstrapUatApi } from './uat-api.js';

void bootstrapUatApi().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'api.runtime_profile.boot_failed',
      error: error instanceof Error ? error.message : 'unknown',
    }),
  );
  process.exit(1);
});

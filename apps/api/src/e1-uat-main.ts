import { bootstrapE1UatApi } from './e1-uat-api.js';

void bootstrapE1UatApi().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'api.runtime_profile.boot_failed',
      error: error instanceof Error ? error.message : 'unknown',
    }),
  );
  process.exit(1);
});

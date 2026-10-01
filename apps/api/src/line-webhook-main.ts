/**
 * Entrypoint ของ service `line-webhook` บน UAT (#565, ADR-031) — ต้องตั้ง `DCONTACT_API_PROFILE=uat-line`
 * ไม่เช่นนั้นบูตไม่ผ่าน; API ของ UAT คือ `uat-main.ts`
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

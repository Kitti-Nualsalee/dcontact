/**
 * Entrypoint ของ API ใน UAT first slice (U1.2 #430) — ต้องตั้ง `DCONTACT_API_PROFILE=uat`
 * ไม่เช่นนั้นบูตไม่ผ่าน; composition root ของ profile อื่นคือ `main.ts`
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

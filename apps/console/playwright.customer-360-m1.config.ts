import { defineConfig, devices } from '@playwright/test';

/** M1 sandbox: browser และ API/RLS จริง พร้อม synthetic identity; ไม่ใช่ actual OIDC */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['customer-360-m1.spec.ts'],
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5198',
    locale: 'th-TH',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  webServer: {
    command:
      'C360_M1_BROWSER=true pnpm --filter @d-contact/api exec tsx --tsconfig tsconfig.json ../console/scripts/customer-360-browser-server.ts',
    url: 'http://127.0.0.1:5198/__c360_test/config',
    timeout: 120_000,
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

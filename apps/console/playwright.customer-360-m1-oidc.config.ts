import { defineConfig, devices } from '@playwright/test';
const devTrial = process.env.C360_DEV_TRIAL === 'true';

/** Console production auth → Keycloak sandbox จริง → API/RLS */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['customer-360-m1-oidc.spec.ts'],
  timeout: 60_000,
  workers: 1,
  retries: 0,
  repeatEach: devTrial ? 2 : 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5188',
    locale: 'th-TH',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  webServer: {
    command:
      'C360_M1_BROWSER_OIDC=true pnpm --filter @d-contact/api exec tsx --tsconfig tsconfig.json ../console/scripts/core-settings-browser-server.ts',
    url: 'http://127.0.0.1:5188/__core_test/config',
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: devTrial
    ? [
        { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
        { name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
      ]
    : [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

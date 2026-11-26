import { defineConfig, devices } from '@playwright/test';
const devTrialBrowser = process.env.C360_DEV_TRIAL_BROWSER;
if (devTrialBrowser && !['chrome', 'edge'].includes(devTrialBrowser))
  throw new Error('C360_DEV_TRIAL_BROWSER must be chrome or edge');

/** Console production auth → real Keycloak sandbox → API/RLS */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['customer-360-m1-oidc.spec.ts'],
  timeout: 60_000,
  workers: 1,
  retries: 0,
  repeatEach: 1,
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
  // start a new process per browser/round so the webServer builds fresh fixtures every time
  projects: devTrialBrowser
    ? [
        {
          name: devTrialBrowser,
          use: {
            ...devices[devTrialBrowser === 'chrome' ? 'Desktop Chrome' : 'Desktop Edge'],
            channel: devTrialBrowser === 'chrome' ? 'chrome' : 'msedge',
          },
        },
      ]
    : [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

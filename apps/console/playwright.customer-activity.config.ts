import { defineConfig, devices } from '@playwright/test';
const browser = process.env.C360_DEV_TRIAL_BROWSER;
if (browser && !['chrome', 'edge'].includes(browser)) throw new Error('Unsupported trial browser');
export default defineConfig({
  testDir: './e2e',
  testMatch: 'customer-activity-oidc.spec.ts',
  timeout: 60000,
  workers: 1,
  retries: 0,
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
      'C360_ACTIVITY_BROWSER_OIDC=true pnpm --filter @d-contact/api exec tsx --tsconfig tsconfig.json ../console/scripts/core-settings-browser-server.ts',
    url: 'http://127.0.0.1:5188/__core_test/config',
    timeout: 180000,
    reuseExistingServer: false,
  },
  projects: browser
    ? [
        {
          name: browser,
          use: { ...devices['Desktop Chrome'], channel: browser === 'edge' ? 'msedge' : 'chrome' },
        },
      ]
    : [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

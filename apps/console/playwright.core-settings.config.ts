import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  testMatch: [
    'core-settings-organization.spec.ts',
    'core-settings-teams.spec.ts',
    'core-settings-navigation.spec.ts',
  ],
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['./scripts/core-settings-reporter.ts']],
  use: {
    baseURL: 'http://127.0.0.1:5188',
    locale: 'th-TH',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  webServer: {
    command:
      'pnpm --filter @d-contact/api exec tsx --tsconfig tsconfig.json ../console/scripts/core-settings-browser-server.ts',
    url: 'http://127.0.0.1:5188/__core_test/config',
    timeout: 120_000,
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

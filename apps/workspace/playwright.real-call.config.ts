import { defineConfig, devices } from '@playwright/test';

/**
 * D1.16 (#455): Playwright on a real call in the dev stack — run only via `pnpm d1:real-call`
 * (the harness prepares a separate DB, the API, Router, Telephony and Workspace at localhost:5173 first); not in regular CI
 */
export default defineConfig({
  testDir: './e2e-real',
  testMatch: 'dphone-real-call.spec.ts',
  outputDir: 'test-results-real',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    permissions: ['microphone'],
    locale: 'th-TH',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        },
      },
    },
  ],
});

import { defineConfig, devices } from '@playwright/test';

/**
 * D1.16 (#455): Playwright บนสายจริงใน dev stack — รันผ่าน `pnpm d1:real-call` เท่านั้น
 * (harness เตรียม DB แยก, API, Router, Telephony และ Workspace ที่ localhost:5173 ให้ก่อน) ไม่อยู่ใน CI ปกติ
 */
export default defineConfig({
  testDir: './e2e-real',
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

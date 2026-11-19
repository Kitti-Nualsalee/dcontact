import { defineConfig, devices } from '@playwright/test';

/**
 * ซ้อม Demo ของทีมขายบน stack ที่ `node scripts/sales-demo-stack.mjs` เปิดไว้ (Workspace ที่ localhost:5173)
 * ไม่อยู่ใน CI และไม่ใช่ acceptance — ใช้ fake media แทนไมโครโฟนจริง
 */
export default defineConfig({
  testDir: './e2e-real',
  testMatch: 'sales-demo-rehearsal.spec.ts',
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
    screenshot: 'only-on-failure',
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

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['junit', { outputFile: 'test-results/junit.xml' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    permissions: ['microphone'],
    // D1.15: ข้อความมาจาก catalog ตามภาษา browser — ชุดเดิมตรวจบนภาษาไทย (spec ที่ต้องการ EN ตั้งเอง)
    locale: 'th-TH',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        },
      },
    },
  ],
  webServer: {
    command: 'pnpm dev --mode e2e --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});

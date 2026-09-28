import { defineConfig, devices } from '@playwright/test';

/**
 * U1.7 (#435): acceptance gate ของ UAT first slice บน backend จริง — รันผ่าน `pnpm cxa:u1:acceptance`
 * เท่านั้น (runner เตรียม Keycloak realm/บัญชี, fixture pack และ API profile `uat` ให้ก่อน)
 *
 * หลักฐานตาม #379 = screenshot ที่ spec ถ่ายเองและ manifest เท่านั้น: ปิด trace/video/screenshot อัตโนมัติ
 * เพราะ trace/HAR/video มี header/token อยู่ข้างใน
 */
const port = Number(process.env.U1_CONSOLE_PORT ?? 5176);

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  expect: { timeout: 20_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: process.env.U1_PLAYWRIGHT_REPORT ?? 'test-results/u1-report.json' }],
  ],
  use: {
    baseURL: `http://localhost:${port}`,
    locale: 'th-TH',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  webServer: {
    command: `pnpm exec vite --config e2e-uat/vite.config.ts --host localhost --port ${port} --strictPort`,
    cwd: '..',
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
  ],
});

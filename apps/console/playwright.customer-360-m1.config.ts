import { defineConfig, devices } from '@playwright/test';
const devTrialBrowser = process.env.C360_DEV_TRIAL_BROWSER;
if (devTrialBrowser && !['chrome', 'edge'].includes(devTrialBrowser))
  throw new Error('C360_DEV_TRIAL_BROWSER ต้องเป็น chrome หรือ edge');

/** M1 sandbox: browser และ API/RLS จริง พร้อม synthetic identity; ไม่ใช่ actual OIDC */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['customer-360-m1.spec.ts'],
  timeout: 60_000,
  workers: 1,
  retries: 0,
  repeatEach: 1,
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
  // รัน process ใหม่ต่อ browser/รอบ เพื่อให้ webServer สร้าง fixtures ใหม่ทุกครั้ง
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

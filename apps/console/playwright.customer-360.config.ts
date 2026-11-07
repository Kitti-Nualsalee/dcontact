import { defineConfig, devices } from '@playwright/test';
const devTrialBrowser = process.env.C360_DEV_TRIAL_BROWSER;
if (devTrialBrowser && !['chrome', 'edge'].includes(devTrialBrowser))
  throw new Error('C360_DEV_TRIAL_BROWSER ต้องเป็น chrome หรือ edge');
const browserPort = Number(process.env.C360_BROWSER_PORT ?? 5198);

/**
 * Cus360 C2 (#792): browser tests ของ Customers/โปรไฟล์ (read-only)
 * sandbox: Vite (mode e2e) → proxy → API/RLS/DB จริง ผ่าน `scripts/customer-360-browser-server.ts`
 * ต้องตั้ง DATABASE_URL / APPLICATION_DATABASE_URL ของ DB แยก (ห้ามใช้ DB ร่วมหรือ UAT)
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['customer-360-*.spec.ts'],
  // M1 ใช้ sandbox/identity คนละชุดและมี config เฉพาะ ห้ามรันผ่าน C2 config
  testIgnore: [
    'customer-360-m1.spec.ts',
    'customer-360-m1-oidc.spec.ts',
    'customer-360-c4-oidc.spec.ts',
  ],
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  repeatEach: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${browserPort}`,
    locale: 'th-TH',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  webServer: {
    command:
      'pnpm --filter @d-contact/api exec tsx --tsconfig tsconfig.json ../console/scripts/customer-360-browser-server.ts',
    url: `http://127.0.0.1:${browserPort}/__c360_test/config`,
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

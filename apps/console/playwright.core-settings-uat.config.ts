import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.CORE_SETTINGS_BASE_URL;
if (baseURL !== 'https://dcontact-uat.osd.co.th')
  throw new Error(
    'ต้องตั้ง CORE_SETTINGS_BASE_URL เป็น HTTPS ของ VM UAT จริงและ map hosts ตาม ADR-030',
  );

// เป็น read-only preflight ของ browser จริง ไม่ใช้ local harness หรือสร้างผล business cases
export default defineConfig({
  testDir: './e2e-core-uat',
  testMatch: 'browser-preflight.spec.ts',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: '../../artifacts/core-settings/uat-browser-preflight',
  use: {
    baseURL,
    headless: false,
    ignoreHTTPSErrors: false,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
  },
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    { name: 'msedge', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
  ],
});

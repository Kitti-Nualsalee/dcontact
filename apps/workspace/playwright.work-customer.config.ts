import { defineConfig, devices } from '@playwright/test';
const browser = process.env.C360_DEV_TRIAL_BROWSER;
if (browser && browser !== 'chrome' && browser !== 'edge') throw new Error('Unknown trial browser');
export default defineConfig({
  testDir: './e2e',
  testMatch: 'work-customer.spec.ts',
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4185',
    locale: 'th-TH',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: browser ?? 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(browser ? { channel: browser === 'edge' ? 'msedge' : 'chrome' } : {}),
      },
    },
  ],
  webServer: {
    command: 'pnpm dev --mode e2e --host 127.0.0.1 --port 4185',
    url: 'http://127.0.0.1:4185',
    reuseExistingServer: false,
  },
});

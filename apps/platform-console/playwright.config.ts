import { defineConfig, devices } from '@playwright/test';

/** #744: regression ใช้ Platform API จำลอง; auth ใช้ production root กับ OIDC จำลอง */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5181', locale: 'th-TH', trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'pnpm exec vite --mode e2e --host 127.0.0.1 --port 5181',
      url: 'http://127.0.0.1:5181',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm exec vite --mode auth-e2e --host 127.0.0.1 --port 5182',
      url: 'http://127.0.0.1:5182',
      env: { VITE_KC_ISSUER: 'http://127.0.0.1:5182/oidc', VITE_KC_CLIENT_ID: 'platform-console' },
      reuseExistingServer: false,
    },
    {
      command: 'pnpm exec vite --mode config-e2e --host 127.0.0.1 --port 5183',
      url: 'http://127.0.0.1:5183',
      env: { VITE_KC_ISSUER: '' },
      reuseExistingServer: false,
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

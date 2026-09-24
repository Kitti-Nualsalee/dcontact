import { defineConfig, devices } from '@playwright/test';

/** A1.7 (#412): mock เฉพาะ Platform API บน origin เดียวกัน — ไม่มี Keycloak/backend จริง */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5181', trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm exec vite --mode e2e --host 127.0.0.1 --port 5181',
    url: 'http://127.0.0.1:5181',
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

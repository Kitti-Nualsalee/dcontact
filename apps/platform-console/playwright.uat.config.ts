import { defineConfig, devices } from '@playwright/test';

/**
 * A1.7 (#412) UAT flow against the real system — not in CI
 * Requires: Keycloak (+ `pnpm infra:identity:platform`), the Platform API at :3019 and the platform worker
 */
export default defineConfig({
  testDir: './uat',
  timeout: 180_000,
  // the same operator account: an OTP cannot be reused within the same window — run one test at a time
  workers: 1,
  use: { baseURL: 'http://localhost:5180', trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm exec vite --host localhost --port 5180 --strictPort',
    url: 'http://localhost:5180',
    reuseExistingServer: false,
    env: {
      VITE_KC_ISSUER: process.env.VITE_KC_ISSUER ?? 'http://localhost:8081/realms/dcontact',
      VITE_KC_CLIENT_ID: 'platform-console',
      VITE_PLATFORM_API_URL: process.env.VITE_PLATFORM_API_URL ?? 'http://localhost:3019',
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

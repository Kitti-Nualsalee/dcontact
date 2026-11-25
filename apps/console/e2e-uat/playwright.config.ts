import { defineConfig, devices } from '@playwright/test';

/**
 * U1.7 (#435): acceptance gate of the UAT first slice on a real backend — run only through `pnpm cxa:u1:acceptance`
 * (the runner prepares the Keycloak realm/accounts, fixture pack and API profile `uat` first)
 *
 * evidence per #379 = only screenshots the spec takes itself and the manifest: automatic trace/video/screenshot are off
 * because a trace/HAR/video holds headers/tokens inside
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

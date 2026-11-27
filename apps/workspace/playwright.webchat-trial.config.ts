import { defineConfig, devices } from '@playwright/test';

/**
 * #1044 web chat end to end on the stack that `node scripts/sales-demo-stack.mjs` brings up with `WEBCHAT=on`
 * (Workspace 5173, Console 5174, API 3000). Not in CI and not acceptance of identity: the stack seeds its
 * tenant directly, and the Agent's phone uses fake media.
 */
export default defineConfig({
  testDir: './e2e-real',
  testMatch: 'webchat-trial.spec.ts',
  outputDir: 'test-results-real',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.WEBCHAT_TRIAL_WORKSPACE ?? 'http://localhost:5173',
    // a deployment whose hosts are not in DNS (UAT Solo is reached through a hosts entry)
    ignoreHTTPSErrors: Boolean(process.env.WEBCHAT_TRIAL_HOST_RULES),
    permissions: ['microphone'],
    locale: 'th-TH',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            ...(process.env.WEBCHAT_TRIAL_HOST_RULES
              ? [`--host-resolver-rules=${process.env.WEBCHAT_TRIAL_HOST_RULES}`]
              : []),
          ],
        },
      },
    },
  ],
});

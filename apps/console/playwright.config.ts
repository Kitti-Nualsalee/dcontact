import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  // Core and Customer 360 use the API/DB sandbox of their dedicated config; they do not run with the mocked D1 harness
  testIgnore: ['**/core-settings-*.spec.ts', '**/customer-360-*.spec.ts'],
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5174', trace: 'retain-on-failure', video: 'retain-on-failure' },
  webServer: {
    command: 'pnpm exec vite --mode e2e --host 127.0.0.1 --port 5174',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
  },
  projects: [
    { name: 'chromium', testDir: './e2e', use: { ...devices['Desktop Chrome'] } },
    // D1.16 (#455): evidence screenshots — this project exists only when D1_VISUAL_EVIDENCE_DIR is set, so the normal run/CI/J5 never sees
    // this test at all (it is not skipped — the J5 negative scan forbids test.skip)
    ...(process.env.D1_VISUAL_EVIDENCE_DIR
      ? [
          {
            name: 'd1-visual-evidence',
            testDir: './e2e-evidence',
            use: { ...devices['Desktop Chrome'] },
          },
        ]
      : []),
  ],
});

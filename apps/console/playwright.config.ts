import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5174', trace: 'retain-on-failure', video: 'retain-on-failure' },
  webServer: {
    command: 'pnpm exec vite --mode e2e --host 127.0.0.1 --port 5174',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
  },
  projects: [
    { name: 'chromium', testDir: './e2e', use: { ...devices['Desktop Chrome'] } },
    // D1.16 (#455): ภาพหลักฐาน — มี project นี้เฉพาะเมื่อตั้ง D1_VISUAL_EVIDENCE_DIR ชุดปกติ/CI/J5 จึงไม่เห็น
    // test นี้เลย (ไม่ใช่ถูก skip — J5 negative scan ห้าม test.skip)
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

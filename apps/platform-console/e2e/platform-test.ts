import { test as base, expect } from '@playwright/test';

/** ทุก browser case ต้อง fail แม้แอปจะ catch error จาก API ที่ข้าม boundary แล้วก็ตาม */
export const test = base.extend<{ platformBoundary: void }>({
  platformBoundary: [
    async ({ page }, use) => {
      const forbidden: string[] = [];
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (
          path === '/api/v1/me/navigation' ||
          path === '/api/v1/tenant/locale-defaults' ||
          /\/account(?:\/|$)/.test(path)
        )
          forbidden.push(path);
      });
      await use();
      expect(forbidden, 'Platform Console ห้ามเรียก Tenant/Account API').toEqual([]);
    },
    { auto: true },
  ],
});

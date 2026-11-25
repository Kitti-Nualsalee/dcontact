import { test as base, expect } from '@playwright/test';

/** every browser case must fail even if the app catches an error from an API that crossed the boundary */
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
      expect(forbidden, 'the Platform Console must not call the Tenant/Account API').toEqual([]);
    },
    { auto: true },
  ],
});

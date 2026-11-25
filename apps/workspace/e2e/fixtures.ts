import { test as base, expect, type Page } from '@playwright/test';

/**
 * Workspace uses only three media APIs: getUserMedia({ audio: true }), getTracks()
 * and track.addEventListener('ended') / track.stop() (apps/workspace/src/workspace-app.tsx)
 *
 * so having Chromium open a real simulated audio device does not cover even one more line of our code
 * but makes the wait depend on machine load: when measured with the machine running other work at the same time, tests that open
 * the real device slowed from 2.1 to 4.8 seconds, while tests that stub stayed at 0.73 seconds
 * when the acceptance gate runs the browser check right after Phase 1 that just used the machine heavily, this exceeds
 * Playwright's 5-second expect timeout and the gate fails without any code change
 *
 * so install a media stub that gives a deterministic result to every test through a single page fixture, instead of lengthening the wait
 * which would only hide the symptom; the track is bound to window.__dContactTestMediaTrack so tests that need to
 * simulate the microphone dropping midway can fire dispatchEvent('ended')
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      class TestMediaTrack extends EventTarget {
        stop() {}
      }

      const track = new TestMediaTrack();
      Object.defineProperty(window, '__dContactTestMediaTrack', { value: track });
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => ({ getTracks: () => [track] }),
      });
    });
    await mockWorkSessionLease(page);
    await use(page);
  },
});

/**
 * #569: since E1.10 (#551) Workspace can request a SIP credential only when it holds a work-session lease
 * (the API answers 403 without a lease) — no lease = cannot register SIP = the answer button is unusable
 * so simulate an enforced lease that is issued immediately, as the default for every spec
 * a spec that tests the lease itself (embed-harness, work-session-lease) can override the route
 */
async function mockWorkSessionLease(page: Page) {
  let current: { leaseId: string; surface: string; acquiredAt: string } | undefined;
  let sequence = 0;
  const issue = (surface: string) => {
    sequence += 1;
    current = {
      leaseId: `e2e-work-session-${sequence}`,
      surface,
      acquiredAt: new Date().toISOString(),
    };
    return {
      ...current,
      hostOrigin: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ttlSeconds: 60,
      heartbeatSeconds: 20,
    };
  };
  await page.context().route('**/api/v1/workspace/agent/availability', (route) => {
    const request = route.request();
    const accepted =
      request.method() === 'POST' &&
      request.headers()['x-work-session-lease-id'] === current?.leaseId &&
      request.postDataJSON()?.state === 'AVAILABLE';
    return route.fulfill({
      status: accepted ? 200 : 403,
      json: accepted ? { state: 'AVAILABLE' } : { code: 'WORK_SESSION_CHANGED' },
    });
  });
  // context level: routes of the page and context registered later in a spec come before this mock
  await page.context().route('**/api/v1/me/work-session**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      return route.fulfill({
        json: {
          enforced: true,
          holder: current ? { ...current, hostOrigin: null, busy: false } : null,
        },
      });
    }
    if (request.method() === 'DELETE') {
      current = undefined;
      return route.fulfill({ status: 204 });
    }
    const body = (request.postDataJSON() ?? {}) as { surface?: string };
    return route.fulfill({ status: 201, json: issue(body.surface ?? 'workspace') });
  });
}

export { expect };

import { test as base, expect } from '@playwright/test';

/**
 * Workspace ใช้ media API เพียงสามอย่าง: getUserMedia({ audio: true }), getTracks()
 * และ track.addEventListener('ended') / track.stop() (apps/workspace/src/workspace-app.tsx)
 *
 * การให้ Chromium เปิดอุปกรณ์เสียงจำลองจริงจึงไม่ได้ครอบคลุมโค้ดของเราเพิ่มแม้แต่บรรทัดเดียว
 * แต่ทำให้เวลารอขึ้นกับภาระของเครื่อง: เมื่อวัดโดยให้เครื่องมีงานอื่นพร้อมกัน test ที่เปิด
 * อุปกรณ์จริงช้าขึ้นจาก 2.1 เป็น 4.8 วินาที ขณะที่ test ซึ่ง stub ไว้อยู่ที่ 0.73 วินาทีเท่าเดิม
 * เมื่อ acceptance gate รัน browser check ต่อจาก Phase 1 ที่เพิ่งใช้เครื่องหนัก ค่านี้จึงเลย
 * expect timeout 5 วินาทีของ Playwright และ gate ล้มโดยที่โค้ดไม่ได้เปลี่ยนอะไร
 *
 * จึงติดตั้ง media stub ที่ให้ผลแน่นอนกับทุก test ผ่าน page fixture เดียว แทนที่จะยืดเวลารอ
 * ซึ่งได้แค่ซ่อนอาการ track ถูกผูกไว้ที่ window.__dContactTestMediaTrack เพื่อให้ test ที่ต้อง
 * จำลองไมโครโฟนหลุดกลางทางสั่ง dispatchEvent('ended') ได้
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
    await use(page);
  },
});

export { expect };

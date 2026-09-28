/**
 * E1.11 (#485): entry ของ dphone ที่ถูกฝัง — โหลดจาก shell `/dphone/embed` ของ API
 *
 * ส่วนนี้ทำแค่ตรวจและล็อก host origin; runtime (auth popup, postMessage v1, lease, screen-pop,
 * click-to-call) อยู่ใน E1.13/E1.14 และต่อจาก `window.__dphoneEmbed`
 */
import {
  lockHostOrigin,
  parseEmbedConfig,
  resolveHostOrigin,
  type HostOriginLock,
} from './origin-lock.js';

declare global {
  interface Window {
    __dphoneEmbed?: { lock: HostOriginLock | null; tenant: string | null };
  }
}

const config = parseEmbedConfig(document.getElementById('dphone-embed-config')?.textContent);
const lock =
  window.parent === window
    ? null // เปิดตรง (ไม่ได้ถูกฝัง) ไม่ใช่ใช้งานแบบ embed
    : lockHostOrigin(
        config,
        resolveHostOrigin({
          ancestorOrigins: window.location.ancestorOrigins,
          referrer: document.referrer,
        }),
        window.parent,
      );

document.documentElement.dataset.embedState = lock ? 'locked' : 'blocked';
window.__dphoneEmbed = { lock, tenant: config?.tenant ?? null };

/**
 * D1.11 (#450): message catalog ของแอป — bundle ทั้งสองภาษาโหลดตั้งแต่เริ่ม (ไม่ lazy)
 * เพื่อให้สลับภาษาได้ทันทีโดยไม่มี request และไม่ reload
 *
 * namespace ตามแอป/หน้าจอ: `common` ใช้ร่วมทั้งแอป, หน้าที่ย้ายมาใช้ shell ใหม่ (D1.14/D1.15)
 * เพิ่ม namespace ของตัวเอง เช่น `journeys` — key เป็นรูป `<หมวด>.<สิ่งของ>.<การกระทำ>`
 * `pnpm i18n:check` ใน CI ล้มเมื่อ key ขาดภาษาใดภาษาหนึ่ง
 */
// subpath ที่ไม่มี CSS — resources ถูก import ใน unit test ของ Node ได้
import { uiResources } from '@d-contact/ui-react/i18n';
import commonEn from './locales/en/common.json' with { type: 'json' };
import commonTh from './locales/th/common.json' with { type: 'json' };
import dphoneEn from './locales/en/dphone.json' with { type: 'json' };
import dphoneTh from './locales/th/dphone.json' with { type: 'json' };
import workspaceEn from './locales/en/workspace.json' with { type: 'json' };
import workspaceTh from './locales/th/workspace.json' with { type: 'json' };

export const DEFAULT_NAMESPACE = 'common';

// namespace `ui` ของ component layer (ADR-028) โหลดพร้อมกัน จึงสลับภาษาพร้อมกันทั้งจอ
export const resources = {
  th: { common: commonTh, workspace: workspaceTh, dphone: dphoneTh, ...uiResources.th },
  en: { common: commonEn, workspace: workspaceEn, dphone: dphoneEn, ...uiResources.en },
} as const;

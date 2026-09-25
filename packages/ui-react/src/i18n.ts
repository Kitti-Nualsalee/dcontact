/**
 * D1.10 (#449): ข้อความของ component เอง (ปุ่มปิด, placeholder) อยู่ใน namespace `ui`
 * แอปรวม `uiResources` เข้า resources ของตัวเอง (D1.11) — component อ่านผ่าน i18n instance ของแอป
 *
 * ไม่ประกาศ `CustomTypeOptions` ที่นี่ เพราะแอปเป็นเจ้าของ declaration นั้น (ประกาศซ้ำจะชนกัน)
 * จึงตรึงชนิดของ key ด้วย `UiKey` ที่คำนวณจาก catalog ภาษาไทยแทน
 */
import { useTranslation } from 'react-i18next';
import uiEn from './locales/en/ui.json' with { type: 'json' };
import uiTh from './locales/th/ui.json' with { type: 'json' };

export const UI_NAMESPACE = 'ui';

export const uiResources = { th: { ui: uiTh }, en: { ui: uiEn } } as const;

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type UiKey = Leaves<typeof uiTh>;

export function useUiText(): (key: UiKey) => string {
  const { i18n } = useTranslation();
  // ผูก namespace ตายตัว — ภาษาเปลี่ยนตาม i18n ของแอปโดยไม่ต้อง remount
  const t = i18n.getFixedT(null, UI_NAMESPACE) as unknown as (key: string) => string;
  return (key) => t(key);
}

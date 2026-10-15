import type { ShellArea } from './types.js';

/** พื้นที่ที่มีรายการ (แอป) นี้ — ไม่มี = `undefined` */
export function areaOf(areas: readonly ShellArea[] | undefined, appId: string): string | undefined {
  return areas?.find((area) =>
    area.sections.some((section) => section.items.some((item) => item.id === appId)),
  )?.id;
}

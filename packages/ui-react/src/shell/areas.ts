import type { ShellArea } from './types.js';

/** the area that contains this item (app) — none = `undefined` */
export function areaOf(areas: readonly ShellArea[] | undefined, appId: string): string | undefined {
  return areas?.find((area) =>
    area.sections.some((section) => section.items.some((item) => item.id === appId)),
  )?.id;
}

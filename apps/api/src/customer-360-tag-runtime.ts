import { createC360WriteRuntime } from './customer-360-write-runtime.js';

export const CUSTOMER_360_TAG_RUNTIME = Symbol('CUSTOMER_360_TAG_RUNTIME');
export interface C360TagCatalogRuntime {
  readonly ready: boolean;
}

/** Catalog เปิดเฉพาะ deployment ที่เปิด feature ชัดเจนและ parser/release runtime ผ่าน */
export function createC360TagCatalogRuntime(
  env: NodeJS.ProcessEnv = process.env,
): C360TagCatalogRuntime {
  return {
    ready:
      env.C360_TAG_CATALOG_ENABLED === 'true' &&
      (env.NODE_ENV !== 'production' || !!env.CUSTOMER_360_CURSOR_KEYS?.trim()) &&
      createC360WriteRuntime(env).ready,
  };
}

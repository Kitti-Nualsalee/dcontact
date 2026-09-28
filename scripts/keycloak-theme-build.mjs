import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * #515: วาง token และโลโก้ของ packages/ui ลงใน login theme ของ Keycloak
 * theme อ้าง `var(--dc-*)` เท่านั้น ส่วนค่าจริงมาจากสำเนาของ tokens.css ที่สคริปต์นี้คัดลอก
 * จึงมีแหล่งความจริงเดียว (standing constraint ของ D1) — ไฟล์ที่คัดลอกไม่ commit
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const themeResources = 'infra/keycloak/themes/dcontact/login/resources';

export const THEME_ASSETS = Object.freeze([
  { from: 'packages/ui/src/tokens.css', to: `${themeResources}/css/tokens.css` },
  { from: 'packages/ui/assets/brand/d-contact-icon-192.png', to: `${themeResources}/img/logo.png` },
  { from: 'packages/ui/assets/brand/favicon.ico', to: `${themeResources}/img/favicon.ico` },
]);

export function buildKeycloakTheme(root = repositoryRoot) {
  for (const { from, to } of THEME_ASSETS) {
    mkdirSync(dirname(resolve(root, to)), { recursive: true });
    copyFileSync(resolve(root, from), resolve(root, to));
  }
  return THEME_ASSETS.map(({ to }) => to);
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  const files = buildKeycloakTheme();
  process.stdout.write(
    `${JSON.stringify({ type: 'keycloak.theme.build', status: 'PASS', files })}\n`,
  );
}

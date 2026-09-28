import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * #515: วาง token และโลโก้ของ packages/ui ลงใน login theme ของ Keycloak
 * theme อ้าง `var(--dc-*)` เท่านั้น ส่วนค่าจริงมาจากสำเนาของ tokens.css ที่สคริปต์นี้คัดลอก
 * จึงมีแหล่งความจริงเดียว (standing constraint ของ D1) — ไฟล์ที่คัดลอกไม่ commit
 *
 * #522: mail client ไม่รองรับ `var()` — email theme อ้าง `dc["ชื่อ-token"]` จาก dc-tokens.ftl
 * ที่สคริปต์นี้สร้างจาก tokens.css เดียวกัน (ไม่ commit เช่นกัน)
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const themeResources = 'infra/keycloak/themes/dcontact/login/resources';
const tokensSource = 'packages/ui/src/tokens.css';

export const THEME_ASSETS = Object.freeze([
  { from: tokensSource, to: `${themeResources}/css/tokens.css` },
  { from: 'packages/ui/assets/brand/d-contact-icon-192.png', to: `${themeResources}/img/logo.png` },
  { from: 'packages/ui/assets/brand/favicon.ico', to: `${themeResources}/img/favicon.ico` },
]);

export const EMAIL_TOKENS = 'infra/keycloak/themes/dcontact/email/html/dc-tokens.ftl';

/**
 * ค่าของ `--dc-*` ตามที่ประกาศครั้งแรกใน tokens.css (ธีม light/density default)
 * ตัดชื่อนำหน้า `--dc-` และแปลง rem เป็น px (root 16px) เพราะ mail client บางตัวคิด rem ผิด
 */
export function parseTokens(css) {
  const tokens = {};
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, name, value] of source.matchAll(/--dc-([\w-]+)\s*:\s*([^;]+);/g)) {
    if (name in tokens) continue;
    tokens[name] = value
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/(\d*\.?\d+)rem\b/g, (_, rem) => `${Number(rem) * 16}px`);
  }
  return tokens;
}

export function emailTokensFtl(tokens) {
  const entries = Object.entries(tokens).map(
    ([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`,
  );
  return `<#-- สร้างโดย scripts/keycloak-theme-build.mjs จาก ${tokensSource} — ห้ามแก้ด้วยมือ -->\n<#assign dc = {\n${entries.join(',\n')}\n}>\n`;
}

export function buildKeycloakTheme(root = repositoryRoot) {
  for (const { from, to } of THEME_ASSETS) {
    mkdirSync(dirname(resolve(root, to)), { recursive: true });
    copyFileSync(resolve(root, from), resolve(root, to));
  }
  mkdirSync(dirname(resolve(root, EMAIL_TOKENS)), { recursive: true });
  writeFileSync(
    resolve(root, EMAIL_TOKENS),
    emailTokensFtl(parseTokens(readFileSync(resolve(root, tokensSource), 'utf8'))),
  );
  return [...THEME_ASSETS.map(({ to }) => to), EMAIL_TOKENS];
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  const files = buildKeycloakTheme();
  process.stdout.write(
    `${JSON.stringify({ type: 'keycloak.theme.build', status: 'PASS', files })}\n`,
  );
}

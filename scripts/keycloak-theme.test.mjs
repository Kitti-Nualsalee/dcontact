import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  EMAIL_TOKENS,
  THEME_ASSETS,
  buildKeycloakTheme,
  parseTokens,
} from './keycloak-theme-build.mjs';
import { EMAIL_THEME, LOGIN_THEME, PLATFORM_LOGIN_THEME } from './keycloak-theme-setup.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
// ตัด comment ของ CSS และ FreeMarker ออกก่อนตรวจ (comment อ้างเลข issue เช่น #515 ได้)
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<#--[\s\S]*?-->/g, '');
const themeDir = 'infra/keycloak/themes/dcontact/login';
const css = read(`${themeDir}/resources/css/dcontact.css`);
const template = read(`${themeDir}/template.ftl`);
const login = read(`${themeDir}/login.ftl`);
const otp = read(`${themeDir}/login-otp.ftl`);
const loginUsername = read(`${themeDir}/login-username.ftl`);
const loginPassword = read(`${themeDir}/login-password.ftl`);
const emailDir = 'infra/keycloak/themes/dcontact/email';
const emailLayout = read(`${emailDir}/html/template.ftl`);
const emailHtml = read(`${emailDir}/html/executeActions.ftl`);
const emailText = read(`${emailDir}/text/executeActions.ftl`);

function messageKeys(path) {
  return new Set(
    read(path)
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#'))
      .map((line) => line.slice(0, line.indexOf('='))),
  );
}

test('theme ไม่มีค่าสีตรง — ทุกสีมาจาก token (standing constraint ของ D1)', () => {
  for (const [name, source] of Object.entries({
    css,
    template,
    login,
    otp,
    loginUsername,
    loginPassword,
    emailLayout,
    emailHtml,
    emailText,
  }).map(([key, value]) => [key, code(value)])) {
    assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b(?![-\w])/i, `${name} มี hex`);
    assert.doesNotMatch(source, /\b(rgb|hsl)a?\(/i, `${name} มี rgb()/hsl()`);
  }
});

test('ทุก var(--dc-*) ใน theme มีอยู่จริงใน packages/ui/src/tokens.css', () => {
  const defined = new Set(
    [...read('packages/ui/src/tokens.css').matchAll(/(--dc-[\w-]+)\s*:/g)].map((m) => m[1]),
  );
  // --dc-icon เป็นตัวแปรภายในของ theme สำหรับ mask ไอคอน
  const used = [...css.matchAll(/var\((--dc-[\w-]+)\)/g)]
    .map((m) => m[1])
    .filter((name) => name !== '--dc-icon');
  const missing = [...new Set(used)].filter((name) => !defined.has(name));
  assert.deepEqual(missing, []);
});

test('คง selector ที่ UAT และ boundary test ของ A1 ใช้ (#username #password #otp #kc-login #kc-page-title)', () => {
  assert.match(login, /id="username"[^>]*name="username"/);
  assert.match(login, /id="password"[^>]*name="password"/);
  assert.match(login, /name="login" id="kc-login" type="submit"/);
  assert.match(otp, /id="otp" name="otp"/);
  assert.match(otp, /name="login" id="kc-login" type="submit"/);
  assert.match(loginUsername, /id="username"[\s\S]*?name="username"/);
  assert.match(loginUsername, /name="login" id="kc-login" type="submit"/);
  assert.match(loginPassword, /id="password"[^>]*name="password"/);
  assert.match(loginPassword, /name="login" id="kc-login" type="submit"/);
  assert.match(template, /<h1 id="kc-page-title">/);
});

test('form แรกของหน้าเป็นฟอร์มของหน้านั้น — layout ไม่มี form ก่อน section "form"', () => {
  const layout = code(template);
  const beforeForm = layout.slice(0, layout.indexOf('<#nested "form">'));
  assert.doesNotMatch(beforeForm, /<form[\s>]/);
});

test('ข้อความ dc* ครบทั้ง th และ en และทุกคีย์ที่ template ใช้มีอยู่', () => {
  const th = messageKeys(`${themeDir}/messages/messages_th.properties`);
  const en = messageKeys(`${themeDir}/messages/messages_en.properties`);
  const dc = (keys) => [...keys].filter((key) => key.startsWith('dc')).sort();
  assert.deepEqual(dc(th), dc(en));
  const used = [
    ...`${template}${login}${otp}${loginUsername}${loginPassword}`.matchAll(/msg\("(dc\w+)"\)/g),
  ].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(used)].filter((key) => !th.has(key)),
    [],
  );
});

test('child theme ของ Platform ต่อจาก dcontact และสลับแผงด้วย dcVariant', () => {
  const properties = read('infra/keycloak/themes/dcontact-platform/login/theme.properties');
  assert.match(properties, /^parent=dcontact$/m);
  assert.match(properties, /^dcVariant=platform$/m);
  assert.match(template, /properties\.dcVariant/);
});

test('realm ใหม่ใช้ theme dcontact และ client platform-console ใช้ child theme', () => {
  const realm = JSON.parse(read('infra/keycloak/realm-dcontact.dev.json'));
  assert.equal(realm.loginTheme, LOGIN_THEME);
  assert.equal(realm.emailTheme, EMAIL_THEME);
  assert.match(
    read('scripts/keycloak-platform-setup.mjs'),
    new RegExp(`login_theme: '${PLATFORM_LOGIN_THEME}'`),
  );
});

test('build คัดลอก token และโลโก้จาก packages/ui ไปที่ resources ของ theme', () => {
  const root = mkdtempSync(join(tmpdir(), 'kc-theme-'));
  for (const { from } of THEME_ASSETS) {
    mkdirSync(dirname(join(root, from)), { recursive: true });
    copyFileSync(new URL(`../${from}`, import.meta.url), join(root, from));
  }
  const written = buildKeycloakTheme(root);
  for (const path of written) assert.ok(existsSync(join(root, path)), path);
  assert.equal(
    readFileSync(join(root, `${themeDir}/resources/css/tokens.css`), 'utf8'),
    read('packages/ui/src/tokens.css'),
  );
  const emailTokens = readFileSync(join(root, EMAIL_TOKENS), 'utf8');
  assert.match(emailTokens, /"surface-brand": "#[0-9a-f]{6}"/);
  assert.match(emailTokens, /"text-md": "16px"/);
});

test('email theme อ้างเฉพาะ token ที่มีอยู่จริงใน tokens.css (#522)', () => {
  const defined = parseTokens(read('packages/ui/src/tokens.css'));
  const used = [...emailLayout.matchAll(/dc\['([\w-]+)'\]/g)].map((m) => m[1]);
  assert.ok(used.length > 0);
  assert.deepEqual(
    [...new Set(used)].filter((name) => !(name in defined)),
    [],
  );
  assert.equal(parseTokens(':root { --dc-a: 1.25rem; --dc-a: #000; }').a, '20px');
});

test('อีเมล plain text มีลิงก์อยู่บรรทัดของตัวเอง — invitationLinks อ่านลิงก์ action-token จาก Text (#522)', () => {
  assert.match(code(emailText), /^\$\{link\}$/m);
  assert.match(emailHtml, /@layout\.button href=link/);
});

test('ข้อความของ email theme ครบทั้ง th และ en (#522)', () => {
  const th = messageKeys(`${emailDir}/messages/messages_th.properties`);
  const en = messageKeys(`${emailDir}/messages/messages_en.properties`);
  assert.deepEqual([...th].sort(), [...en].sort());
  const used = [...`${emailLayout}${emailHtml}${emailText}`.matchAll(/msg\("(dc\w+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    [...new Set(used)].filter((key) => !th.has(key)),
    [],
  );
});

test('ลิงก์ action-token ลิงก์แรกของหน้าเป็นของเนื้อหา — ตัวเลือกภาษาอยู่หลัง section "form" และ "info"', () => {
  const layout = code(template);
  const locale = layout.indexOf('id="kc-locale"');
  assert.ok(locale > layout.indexOf('<#nested "form">'));
  assert.ok(locale > layout.indexOf('<#nested "info">'));
});

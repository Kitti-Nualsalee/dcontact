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
// strip CSS and FreeMarker comments before checking (a comment may mention an issue number such as #515)
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
// AC6 (#599): the Keycloak emails customers receive must be in the same layout as the invitation email
const AC6_EMAILS = ['email-verification', 'password-reset'];
const ac6EmailHtml = AC6_EMAILS.map((name) => read(`${emailDir}/html/${name}.ftl`)).join('\n');
const ac6EmailText = AC6_EMAILS.map((name) => read(`${emailDir}/text/${name}.ftl`)).join('\n');

function messageKeys(path) {
  return new Set(
    read(path)
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#'))
      .map((line) => line.slice(0, line.indexOf('='))),
  );
}

test('the theme has no direct color values - every color comes from a token (a standing constraint of D1)', () => {
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
    assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b(?![-\w])/i, `${name} has a hex`);
    assert.doesNotMatch(source, /\b(rgb|hsl)a?\(/i, `${name} has rgb()/hsl()`);
  }
});

test('every var(--dc-*) in the theme really exists in packages/ui/src/tokens.css', () => {
  const defined = new Set(
    [...read('packages/ui/src/tokens.css').matchAll(/(--dc-[\w-]+)\s*:/g)].map((m) => m[1]),
  );
  // --dc-icon is an internal theme variable for the icon mask
  const used = [...css.matchAll(/var\((--dc-[\w-]+)\)/g)]
    .map((m) => m[1])
    .filter((name) => name !== '--dc-icon');
  const missing = [...new Set(used)].filter((name) => !defined.has(name));
  assert.deepEqual(missing, []);
});

test('keeps the selectors that UAT and the A1 boundary test use (#username #password #otp #kc-login #kc-page-title)', () => {
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

test('the first form on the page is the form of that page - the layout has no form before the "form" section', () => {
  const layout = code(template);
  const beforeForm = layout.slice(0, layout.indexOf('<#nested "form">'));
  assert.doesNotMatch(beforeForm, /<form[\s>]/);
});

test('the dc* messages are complete in both th and en and every key the template uses exists', () => {
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

test("the theme messages have no single apostrophe - Keycloak sends every message through MessageFormat, which swallows a lone '", () => {
  for (const path of [
    `${themeDir}/messages/messages_th.properties`,
    `${themeDir}/messages/messages_en.properties`,
    `${emailDir}/messages/messages_th.properties`,
    `${emailDir}/messages/messages_en.properties`,
  ]) {
    const values = read(path)
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#'))
      .map((line) => line.slice(line.indexOf('=') + 1));
    assert.deepEqual(
      values.filter((value) => /(^|[^'])'([^']|$)/.test(value)),
      [],
      path,
    );
  }
});

test('the Platform child theme extends dcontact and swaps the panel with dcVariant', () => {
  const properties = read('infra/keycloak/themes/dcontact-platform/login/theme.properties');
  assert.match(properties, /^parent=dcontact$/m);
  assert.match(properties, /^dcVariant=platform$/m);
  assert.match(template, /properties\.dcVariant/);
});

test('a new realm uses the dcontact theme and the platform-console client uses the child theme', () => {
  const realm = JSON.parse(read('infra/keycloak/realm-dcontact.dev.json'));
  assert.equal(realm.loginTheme, LOGIN_THEME);
  assert.equal(realm.emailTheme, EMAIL_THEME);
  assert.match(
    read('scripts/keycloak-platform-setup.mjs'),
    new RegExp(`login_theme: '${PLATFORM_LOGIN_THEME}'`),
  );
});

test('the build copies the tokens and logo from packages/ui into the theme resources', () => {
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

test('the email theme references only tokens that really exist in tokens.css (#522)', () => {
  const defined = parseTokens(read('packages/ui/src/tokens.css'));
  const used = [...emailLayout.matchAll(/dc\['([\w-]+)'\]/g)].map((m) => m[1]);
  assert.ok(used.length > 0);
  assert.deepEqual(
    [...new Set(used)].filter((name) => !(name in defined)),
    [],
  );
  assert.equal(parseTokens(':root { --dc-a: 1.25rem; --dc-a: #000; }').a, '20px');
});

test('the plain text email has the link on its own line - invitationLinks reads the action-token link from Text (#522)', () => {
  assert.match(code(emailText), /^\$\{link\}$/m);
  assert.match(emailHtml, /@layout\.button href=link/);
});

test('the email theme messages are complete in both th and en (#522)', () => {
  const th = messageKeys(`${emailDir}/messages/messages_th.properties`);
  const en = messageKeys(`${emailDir}/messages/messages_en.properties`);
  assert.deepEqual([...th].sort(), [...en].sort());
  const used = [
    ...`${emailLayout}${emailHtml}${emailText}${ac6EmailHtml}${ac6EmailText}`.matchAll(
      /msg\("(dc\w+)"/g,
    ),
  ].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(used)].filter((key) => !th.has(key)),
    [],
  );
});

test('the first action-token link on the page belongs to the content - the language chooser comes after the "form" and "info" sections', () => {
  const layout = code(template);
  const locale = layout.indexOf('id="kc-locale"');
  assert.ok(locale > layout.indexOf('<#nested "form">'));
  assert.ok(locale > layout.indexOf('<#nested "info">'));
});

test('AC6 (#599): the verify-email and forgot-password emails use the D-Contact layout and have the link on its own line', () => {
  for (const name of AC6_EMAILS) {
    const html = read(`${emailDir}/html/${name}.ftl`);
    const text = read(`${emailDir}/text/${name}.ftl`);
    assert.match(html, /<#import "template\.ftl" as layout>/, name);
    assert.match(html, /@layout\.button href=link/, name);
    assert.match(code(text), /^\$\{link\}$/m, name);
    // emails do not show the realm name, the user, or the recipient email
    assert.doesNotMatch(code(`${html}${text}`), /realmName|user\.|username/, name);
  }
});

test('AC6 (#599): the theme messages and templates have no word Keycloak in the user-visible parts', () => {
  for (const path of [
    `${themeDir}/messages/messages_th.properties`,
    `${themeDir}/messages/messages_en.properties`,
    `${emailDir}/messages/messages_th.properties`,
    `${emailDir}/messages/messages_en.properties`,
  ]) {
    const visible = read(path)
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#'))
      .join('\n');
    assert.doesNotMatch(visible, /keycloak/i, path);
  }
  // messages where the Keycloak base theme puts this word must be overridden (the subject of the SMTP test email)
  for (const locale of ['th', 'en']) {
    assert.ok(
      messageKeys(`${emailDir}/messages/messages_${locale}.properties`).has('emailTestSubject'),
      locale,
    );
  }
  const ftl = [
    template,
    login,
    otp,
    loginUsername,
    loginPassword,
    emailLayout,
    emailHtml,
    emailText,
    ac6EmailHtml,
    ac6EmailText,
  ]
    .map(code)
    .join('\n');
  assert.doesNotMatch(ftl, /keycloak/i);
});

test('AC6 (#599): the account theme sends /realms/dcontact/account/ to D-Contact through the dc-account extension', () => {
  const properties = read('infra/keycloak/themes/dcontact/account/theme.properties');
  const provider = properties.match(/^accountResourceProvider=(.+)$/m)?.[1];
  assert.equal(provider, 'dc-account-landing');
  const javaDir = 'infra/keycloak/extensions/dc-account/src/main';
  assert.match(
    read(`${javaDir}/java/io/dcontact/keycloak/account/DcAccountLandingProviderFactory.java`),
    new RegExp(`ID = "${provider}"`),
  );
  assert.match(
    read(
      `${javaDir}/resources/META-INF/services/org.keycloak.services.resource.AccountResourceProviderFactory`,
    ),
    /DcAccountLandingProviderFactory/,
  );
  for (const file of ['dev', 'uat']) {
    const realm = JSON.parse(read(`infra/keycloak/realm-dcontact.${file}.json`));
    assert.equal(realm.accountTheme, 'dcontact', file);
    assert.equal(realm.displayName, 'D-Contact', file);
  }
});

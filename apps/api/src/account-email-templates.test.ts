import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCOUNT_EMAIL_LOCALES,
  ACCOUNT_EMAIL_TEMPLATES,
  AccountEmailTemplateError,
  consoleAccountUrl,
  maskEmail,
  renderAccountEmail,
} from './account-email-templates.js';
import {
  AccountEmailConfigError,
  fromAddressOf,
  smtpConfigFromEnvironment,
} from './account-email.js';

const CONSOLE = 'https://uat.dcontact.test';
const variables = {
  'verify-new-email': { token: 'tok_abc-123', expiresInMinutes: 30 },
  'email-changed-notice': {
    newEmail: 'somchai.new@example.com',
    changedAt: '2026-10-06T03:15:00.000Z',
  },
  'password-changed-notice': { changedAt: '2026-10-06T03:15:00.000Z' },
} as const;

const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!);
const urls = (text: string) => text.match(/https?:\/\/\S+/g) ?? [];

test('render ครบทุก template ทั้ง TH/EN: มี subject/html/text, ไม่มีคำว่า Keycloak, ลิงก์ชี้ host ของ D-Contact', () => {
  for (const template of ACCOUNT_EMAIL_TEMPLATES) {
    for (const locale of ACCOUNT_EMAIL_LOCALES) {
      const email = renderAccountEmail(template, locale, variables[template], {
        consoleUrl: CONSOLE,
      });
      const label = `${template}/${locale}`;
      assert.ok(email.subject.includes('D-Contact'), label);
      assert.match(email.html, new RegExp(`<html lang="${locale}">`), label);
      for (const part of [email.subject, email.html, email.text]) {
        assert.doesNotMatch(part, /keycloak|realms\//i, label);
      }
      const links = [...hrefs(email.html), ...urls(email.text)];
      assert.ok(links.length >= 2, label);
      for (const link of links) {
        const url = new URL(link.replaceAll('&amp;', '&'));
        assert.equal(url.origin, CONSOLE, `${label}: ${link}`);
        assert.equal(url.searchParams.get('view'), 'account', label);
      }
      // html ไม่มี stylesheet/var() — mail client ไม่รองรับ
      assert.doesNotMatch(email.html, /<style|var\(--|rem;/, label);
      assert.match(email.text, /D-Contact/);
    }
  }
});

test('ภาษาตาม locale และเนื้อหาของแต่ละ template', () => {
  const verifyTh = renderAccountEmail('verify-new-email', 'th', variables['verify-new-email'], {
    consoleUrl: CONSOLE,
  });
  assert.equal(verifyTh.subject, 'ยืนยันอีเมลใหม่ของบัญชี D-Contact');
  assert.ok(verifyTh.text.includes('30 นาที'));
  assert.ok(verifyTh.text.includes(`${CONSOLE}/?view=account&verify=tok_abc-123`));

  const verifyEn = renderAccountEmail('verify-new-email', 'en', variables['verify-new-email'], {
    consoleUrl: CONSOLE,
  });
  assert.equal(verifyEn.subject, 'Confirm the new email for your D-Contact account');
  assert.ok(verifyEn.text.includes('30 minutes'));

  // ถึงอีเมลเดิม: อีเมลใหม่ถูกปิดบางส่วน และไม่มีลิงก์ยืนยัน
  const changed = renderAccountEmail(
    'email-changed-notice',
    'en',
    variables['email-changed-notice'],
    { consoleUrl: CONSOLE },
  );
  assert.ok(changed.text.includes('s*********w@example.com'));
  assert.ok(!changed.html.includes('somchai.new@example.com'));
  assert.ok(!changed.text.includes('verify='));
  assert.ok(changed.text.includes('6 October 2026 at 10:15'), changed.text);

  const password = renderAccountEmail(
    'password-changed-notice',
    'th',
    variables['password-changed-notice'],
    { consoleUrl: CONSOLE },
  );
  assert.equal(password.subject, 'รหัสผ่านของบัญชี D-Contact ถูกเปลี่ยน');
  assert.ok(password.text.includes('ติดต่อผู้ดูแลระบบ'));
});

test('ค่าที่ไม่น่าไว้ใจถูก escape และตัวแปรผิดถูกปฏิเสธ', () => {
  const email = renderAccountEmail(
    'verify-new-email',
    'th',
    { token: '"><script>alert(1)</script>', expiresInMinutes: 30 },
    { consoleUrl: CONSOLE },
  );
  assert.ok(!email.html.includes('<script>'));
  const notice = renderAccountEmail(
    'email-changed-notice',
    'th',
    { newEmail: '<b>x</b>@evil.test', changedAt: '2026-10-06T03:15:00.000Z' },
    { consoleUrl: CONSOLE },
  );
  assert.ok(!notice.html.includes('<b>'));

  const invalid: Array<[string, string, unknown]> = [
    ['unknown', 'th', {}],
    ['verify-new-email', 'fr', variables['verify-new-email']],
    ['verify-new-email', 'th', { token: '', expiresInMinutes: 30 }],
    ['verify-new-email', 'th', { token: 'x', expiresInMinutes: 0 }],
    ['email-changed-notice', 'th', { newEmail: 'no-at', changedAt: '2026-10-06T03:15:00Z' }],
    ['password-changed-notice', 'th', { changedAt: 'not a date' }],
  ];
  for (const [template, locale, vars] of invalid) {
    assert.throws(
      () => renderAccountEmail(template, locale, vars, { consoleUrl: CONSOLE }),
      AccountEmailTemplateError,
      `${template}/${locale}`,
    );
  }
});

test('ลิงก์ของ Console ต้องเป็น https (ยกเว้น localhost ของ dev)', () => {
  assert.equal(
    consoleAccountUrl('http://localhost:5173', 'a b'),
    'http://localhost:5173/?view=account&verify=a+b',
  );
  assert.throws(() => consoleAccountUrl('http://uat.dcontact.test'), AccountEmailTemplateError);
  assert.equal(
    consoleAccountUrl('https://uat.dcontact.test/ignored/path'),
    `${CONSOLE}/?view=account`,
  );
});

test('ปิดอีเมลบางส่วน', () => {
  assert.equal(maskEmail('somchai@example.com'), 's*****i@example.com');
  assert.equal(maskEmail('ab@example.com'), 'a*@example.com');
  assert.equal(maskEmail('broken'), '***');
});

test('config SMTP จาก env: ไม่ตั้ง host = ปิด; ค่าผิดถูกปฏิเสธ; ชื่อผู้ส่งไม่ขึ้นกับ SMTP_FROM', () => {
  assert.equal(smtpConfigFromEnvironment({}), undefined);
  assert.deepEqual(
    smtpConfigFromEnvironment({
      SMTP_HOST: 'osd-co-th.mail.protection.outlook.com',
      SMTP_PORT: '25',
      SMTP_SECURE: 'false',
      SMTP_FROM: '"OSD Exercise Event" <osd-event@osd.co.th>',
      SMTP_HELO: 'osd.co.th',
    }),
    {
      host: 'osd-co-th.mail.protection.outlook.com',
      port: 25,
      secure: false,
      fromAddress: 'osd-event@osd.co.th',
      helo: 'osd.co.th',
    },
  );
  assert.deepEqual(
    smtpConfigFromEnvironment({
      SMTP_HOST: 'smtp.example.test',
      SMTP_PORT: '465',
      SMTP_SECURE: 'TRUE',
      SMTP_USER: 'u',
      SMTP_PASSWORD: 'p',
      SMTP_FROM: 'no-reply@example.test',
    }),
    {
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      user: 'u',
      password: 'p',
      fromAddress: 'no-reply@example.test',
    },
  );
  for (const [variable, environment] of [
    ['SMTP_PORT', { SMTP_HOST: 'h', SMTP_PORT: '0', SMTP_FROM: 'a@b' }],
    ['SMTP_SECURE', { SMTP_HOST: 'h', SMTP_SECURE: 'yes', SMTP_FROM: 'a@b' }],
    ['SMTP_PASSWORD', { SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_FROM: 'a@b' }],
    ['SMTP_FROM', { SMTP_HOST: 'h' }],
  ] as const) {
    assert.throws(
      () => smtpConfigFromEnvironment(environment),
      (error: unknown) => error instanceof AccountEmailConfigError && error.variable === variable,
    );
  }
  assert.equal(fromAddressOf('"D-Contact" <no-reply@dcontact.local>'), 'no-reply@dcontact.local');
});

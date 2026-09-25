import assert from 'node:assert/strict';
import test from 'node:test';
import { createI18n } from './i18n.js';

const resources = {
  th: { common: { greeting: 'สวัสดี {{name}}', item_other: '{{count}} รายการ' } },
  en: {
    common: {
      greeting: 'Hello {{name}}',
      item_one: '{{count}} item',
      item_other: '{{count}} items',
    },
  },
};

test('init แบบ sync — แปลได้ทันทีโดยไม่ต้องรอ และสลับภาษาโดยไม่โหลดอะไรเพิ่ม', async () => {
  const i18n = createI18n({ resources, locale: 'th', defaultNamespace: 'common' });
  assert.equal(i18n.t('greeting', { name: 'Ann & Bo' }), 'สวัสดี Ann & Bo');
  await i18n.changeLanguage('en');
  assert.equal(i18n.t('greeting', { name: 'Ann' }), 'Hello Ann');
  assert.equal(i18n.t('item', { count: 1 }), '1 item');
  assert.equal(i18n.t('item', { count: 3 }), '3 items');
  await i18n.changeLanguage('th');
  assert.equal(i18n.t('item', { count: 1 }), '1 รายการ');
});

test('instance แยกกันต่อแอป — สลับภาษาของตัวหนึ่งไม่กระทบอีกตัว', async () => {
  const a = createI18n({ resources, locale: 'th', defaultNamespace: 'common' });
  const b = createI18n({ resources, locale: 'th', defaultNamespace: 'common' });
  await a.changeLanguage('en');
  assert.equal(b.language, 'th');
});

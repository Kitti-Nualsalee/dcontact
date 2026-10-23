import assert from 'node:assert/strict';
import test from 'node:test';
import { createI18n } from '@d-contact/i18n';
import { resources, DEFAULT_NAMESPACE } from './i18n/resources.js';
import { describeHistory } from './presentation.js';
import { validateDraft, EMPTY_DRAFT, type ActionHistoryItem } from './model.js';

test('validation/history เปลี่ยนภาษาที่ render โดยข้อมูลและ message keys เดิมไม่เปลี่ยน', async () => {
  const i18n = createI18n({ resources, locale: 'th', defaultNamespace: DEFAULT_NAMESPACE });
  const errors = validateDraft({ ...EMPTY_DRAFT, displayName: 'x' });
  const snapshot = JSON.stringify(errors);
  assert.equal(i18n.t(errors.displayName!), 'กรอกชื่อ 2–120 ตัวอักษร');
  const item: ActionHistoryItem = {
    id: 'audit-id',
    requestId: 'request-id',
    action: 'STEP_ACTION_REQUIRED',
    outcome: 'SUCCEEDED',
    actor: { kind: 'SYSTEM', subject: 'synthetic-worker', role: null },
    stepKey: 'FIRST_ADMIN',
    attempt: 2,
    beforeState: 'RUNNING',
    afterState: 'ACTION_REQUIRED',
    reasonCode: 'OPERATOR_VERIFIED',
    comment: 'ข้อความผู้ใช้ English ไทย',
    errorCode: 'FIRST_ADMIN_EMAIL_CONFLICT',
    correlationId: 'synthetic-correlation',
    occurredAt: '2026-10-22T03:05:00.000Z',
  };
  const original = JSON.stringify(item);
  assert.match(describeHistory(item, i18n.t), /สร้าง First admin/);
  await i18n.changeLanguage('en');
  assert.equal(i18n.t(errors.displayName!), 'Enter a name with 2–120 characters');
  const history = describeHistory(item, i18n.t);
  assert.match(history, /Create first admin/);
  assert.match(history, /Provisioning → Action required/);
  assert.match(history, /attempt 2/);
  assert.match(history, /FIRST_ADMIN_EMAIL_CONFLICT/);
  assert.match(history, /Reason OPERATOR_VERIFIED/);
  assert.equal(JSON.stringify(errors), snapshot);
  assert.equal(JSON.stringify(item), original);
});

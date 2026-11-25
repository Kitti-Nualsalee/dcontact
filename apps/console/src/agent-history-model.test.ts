import assert from 'node:assert/strict';
import test from 'node:test';
import { isHistorySummary } from './agent-history/api.js';
import {
  NO_DISPOSITION,
  dispositionCount,
  dispositionFrom,
  filterHref,
  formatTalk,
  listQuery,
  periodFrom,
} from './agent-history/model.js';

test('period from the URL uses a supported value, otherwise 7 days', () => {
  assert.equal(periodFrom('today'), 'today');
  assert.equal(periodFrom('all'), 'all');
  assert.equal(periodFrom(null), '7d');
  assert.equal(periodFrom('week'), '7d');
});

test('disposition in the URL distinguishes all / none / a specific disposition', () => {
  assert.equal(dispositionFrom(null), undefined);
  assert.equal(dispositionFrom(''), undefined);
  assert.equal(dispositionFrom(NO_DISPOSITION), null);
  assert.equal(dispositionFrom('CUSTOMER_ASSISTED'), 'CUSTOMER_ASSISTED');
  assert.equal(dispositionFrom(`A${'B'.repeat(79)}`)?.length, 80);
  assert.equal(dispositionFrom('a'.repeat(257)), undefined);
});

test('list query sends the period from the summary and the selected disposition', () => {
  assert.equal(listQuery(undefined), 'limit=20');
  assert.equal(
    listQuery(
      { from: '2026-11-15T17:00:00.000Z', to: '2026-11-22T17:00:00.000Z', disposition: null },
      'next',
    ),
    'limit=20&from=2026-11-15T17%3A00%3A00.000Z&to=2026-11-22T17%3A00%3A00.000Z&disposition=__none__&cursor=next',
  );
  assert.equal(listQuery({ from: null, to: null, disposition: 'X' }), 'limit=20&disposition=X');
});

test('filter URL keeps the existing parameters and omits defaults', () => {
  const base = 'https://console.test/?view=agent-history&tenant=demo';
  assert.equal(filterHref(base, '7d', undefined), base);
  assert.equal(
    filterHref(base, 'today', 'FOLLOW_UP_REQUIRED'),
    `${base}&period=today&disposition=FOLLOW_UP_REQUIRED`,
  );
  assert.equal(filterHref(`${base}&period=today&disposition=X`, '7d', undefined), base);
});

test('conversation time is shown as minutes:seconds, and hours when it exceeds them', () => {
  assert.equal(formatTalk(0), '0:00');
  assert.equal(formatTalk(150), '2:30');
  assert.equal(formatTalk(3725), '1:02:05');
});

test('filter counts come from the summary', () => {
  const groups = [
    { disposition: 'A', count: 3 },
    { disposition: null, count: 1 },
  ];
  assert.equal(dispositionCount(groups, 4, undefined), 4);
  assert.equal(dispositionCount(groups, 4, null), 1);
  assert.equal(dispositionCount(groups, 4, 'B'), 0);
});

test('validates the summary shape from the server before showing it', () => {
  const summary = {
    period: { key: '7d', from: null, to: null, timeZone: 'UTC' },
    completed: 1,
    talk: { averageSeconds: null, measuredCount: 0 },
    byDisposition: [{ disposition: null, count: 1 }],
  };
  assert.equal(isHistorySummary(summary), true);
  assert.equal(isHistorySummary({ items: [], nextCursor: null }), false);
  assert.equal(isHistorySummary({ ...summary, completed: -1 }), false);
  assert.equal(
    isHistorySummary({ ...summary, byDisposition: [{ disposition: NO_DISPOSITION, count: 1 }] }),
    false,
  );
});

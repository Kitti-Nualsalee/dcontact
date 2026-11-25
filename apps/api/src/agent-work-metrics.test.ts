import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  NO_DISPOSITION,
  filterKey,
  periodWindow,
  resolveTimeZone,
  summaryPeriodFrom,
  workFilterFrom,
  zonedDayStart,
} from './agent-work-metrics.js';

const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof BadRequestException);
    return (error.getResponse() as { code: string }).code;
  }
  assert.fail('expected BadRequestException');
};

test('the day boundary uses the tenant time zone — 00:30 in Bangkok is already a new day even though UTC is still yesterday', () => {
  const now = new Date('2026-11-21T17:30:00.000Z'); // 22 Nov 00:30 Asia/Bangkok
  assert.deepEqual(periodWindow('today', now, 'Asia/Bangkok'), {
    from: new Date('2026-11-21T17:00:00.000Z'),
    to: now,
  });
  assert.deepEqual(periodWindow('today', now, 'UTC'), {
    from: new Date('2026-11-21T00:00:00.000Z'),
    to: now,
  });
});

test('7 days and 30 days count today as well, all has no lower bound, and every period ends at the as-of time', () => {
  const now = new Date('2026-11-22T05:00:00.000Z');
  assert.deepEqual(periodWindow('7d', now, 'Asia/Bangkok'), {
    from: new Date('2026-11-15T17:00:00.000Z'),
    to: now,
  });
  assert.equal(
    periodWindow('30d', now, 'Asia/Bangkok').from?.toISOString(),
    '2026-10-23T17:00:00.000Z',
  );
  assert.deepEqual(periodWindow('all', now, 'Asia/Bangkok'), { from: null, to: now });
});

test('a period that spans a DST change gets local midnight on both sides', () => {
  // America/New_York goes back to standard time on 1 Nov 2026
  const now = new Date('2026-11-03T15:00:00.000Z');
  assert.equal(zonedDayStart(now, 'America/New_York', 0).toISOString(), '2026-11-03T05:00:00.000Z');
  assert.equal(zonedDayStart(now, 'America/New_York', 6).toISOString(), '2026-10-28T04:00:00.000Z');
});

test('a midnight that disappears on entering DST uses the first instant of that day, not going back to the previous day', () => {
  // America/Santiago skips from 00:00 to 01:00 on 6 Sep 2026
  assert.equal(
    zonedDayStart(new Date('2026-09-06T15:00:00.000Z'), 'America/Santiago', 0).toISOString(),
    '2026-09-06T04:00:00.000Z',
  );
  // America/Havana skips midnight on 8 Mar 2026
  assert.equal(
    zonedDayStart(new Date('2026-03-08T15:00:00.000Z'), 'America/Havana', 0).toISOString(),
    '2026-03-08T05:00:00.000Z',
  );
});

test('an unknown or unset time zone uses UTC', () => {
  assert.equal(resolveTimeZone('Asia/Bangkok'), 'Asia/Bangkok');
  assert.equal(resolveTimeZone('Mars/Base'), 'UTC');
  assert.equal(resolveTimeZone(null), 'UTC');
});

test('period accepts only supported values, with a default of 7 days', () => {
  assert.equal(summaryPeriodFrom(undefined), '7d');
  assert.equal(summaryPeriodFrom('today'), 'today');
  for (const value of ['', '1d', ['7d'], 'ALL'])
    assert.equal(
      code(() => summaryPeriodFrom(value)),
      'INVALID_PERIOD',
    );
});

test('the list filter checks time, range and wrap-up result', () => {
  const filter = workFilterFrom({
    from: '2026-11-15T17:00:00.000Z',
    to: '2026-11-22T17:00:00.000Z',
    disposition: 'CUSTOMER_ASSISTED',
  });
  assert.equal(filter.disposition, 'CUSTOMER_ASSISTED');
  assert.equal(workFilterFrom({ disposition: NO_DISPOSITION }).disposition, null);
  assert.equal(workFilterFrom({}).disposition, undefined);
  assert.equal(
    code(() => workFilterFrom({ from: '2026-11-15' })),
    'INVALID_FROM',
  );
  assert.equal(
    code(() => workFilterFrom({ to: ['2026-11-15T17:00:00.000Z'] })),
    'INVALID_TO',
  );
  assert.equal(
    code(() =>
      workFilterFrom({ from: '2026-11-15T17:00:00.000Z', to: '2026-11-15T17:00:00.000Z' }),
    ),
    'INVALID_RANGE',
  );
  assert.equal(workFilterFrom({ disposition: `A${'B'.repeat(79)}` }).disposition?.length, 80);
  for (const disposition of ['', 'a'.repeat(257), 'bad\nvalue'])
    assert.equal(
      code(() => workFilterFrom({ disposition })),
      'INVALID_DISPOSITION',
    );
});

test('the cursor binds to the filter — every wrap-up result, no wrap-up result and specific results differ', () => {
  const keys = new Set([
    filterKey({ from: null, to: null }),
    filterKey({ from: null, to: null, disposition: null }),
    filterKey({ from: null, to: null, disposition: 'CUSTOMER_ASSISTED' }),
    filterKey({ from: new Date(0), to: null }),
  ]);
  assert.equal(keys.size, 4);
});

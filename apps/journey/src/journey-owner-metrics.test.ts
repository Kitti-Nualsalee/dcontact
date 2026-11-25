/**
 * J2.8 (#136) — proves that the observability of the owner path carries no PII or identifier out
 *
 * the metric backend has longer retention and broader access than the database; anything that leaks
 * there is leaked permanently — so this suite checks "what is really emitted", not just that the
 * interface has the right shape
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JsonJourneyOwnerMetrics,
  noOpJourneyOwnerMetrics,
  type JourneyOwnerCounterMetric,
  type JourneyOwnerGaugeMetric,
} from './journey-owner-metrics.js';

const COUNTERS: JourneyOwnerCounterMetric[] = [
  'journey_owner_command_dispatched_total',
  'journey_owner_command_dispatch_failed_total',
  'journey_owner_result_applied_total',
  'journey_owner_result_duplicate_total',
  'journey_owner_result_conflict_total',
  'journey_owner_result_binding_rejected_total',
  'journey_owner_ack_unknown_total',
  'journey_owner_ack_reconciled_total',
  'journey_owner_ack_escalated_total',
];

const GAUGES: JourneyOwnerGaugeMetric[] = [
  'journey_owner_dispatch_to_result_ms',
  'journey_owner_ack_attempts',
];

/** intercepts console.info to see what is really emitted */
function captureEmitted(run: (metrics: JsonJourneyOwnerMetrics) => void): string[] {
  const emitted: string[] = [];
  const original = console.info;
  console.info = (line: unknown) => {
    emitted.push(String(line));
  };
  try {
    run(new JsonJourneyOwnerMetrics());
  } finally {
    console.info = original;
  }
  return emitted;
}

test('every metric emits only the metric name and value, with no other key', () => {
  const emitted = captureEmitted((metrics) => {
    for (const counter of COUNTERS) metrics.increment(counter);
    for (const gauge of GAUGES) metrics.observe(gauge, 1_234);
  });

  assert.equal(emitted.length, COUNTERS.length + GAUGES.length);
  for (const line of emitted) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ['metric', 'value'],
      `a metric payload must have only metric and value but got ${line}`,
    );
    assert.equal(typeof parsed.metric, 'string');
    assert.equal(typeof parsed.value, 'number');
  }
});

test('a metric name has no identifier embedded in it', () => {
  // the name must be a fixed snake_case only — if anyone interpolates an id into it, it is caught here
  for (const metric of [...COUNTERS, ...GAUGES]) {
    assert.match(metric, /^journey_owner_[a-z_]+$/, `malformed metric name: ${metric}`);
  }
});

test('observe does not emit a negative value', () => {
  const emitted = captureEmitted((metrics) => {
    metrics.observe('journey_owner_dispatch_to_result_ms', -5_000);
  });
  assert.equal((JSON.parse(emitted[0]!) as { value: number }).value, 0);
});

test('a label smuggled in beyond the signature still does not leak out', () => {
  // TypeScript guards at compile time but JS always lets extra arguments through — code that
  // is transpiled or called directly from JS can therefore still sneak a label in; this confirms that even if
  // it is really sneaked in the emitted payload still has only metric and value
  const sneaky = { tenantId: 'tenant-1', contactId: 'contact-1' };
  const emitted = captureEmitted((metrics) => {
    (metrics.increment as (m: string, extra?: unknown) => void)(
      'journey_owner_ack_escalated_total',
      sneaky,
    );
    (metrics.observe as (m: string, v: number, extra?: unknown) => void)(
      'journey_owner_ack_attempts',
      3,
      sneaky,
    );
  });

  for (const line of emitted) {
    assert.deepEqual(Object.keys(JSON.parse(line) as object).sort(), ['metric', 'value']);
    assert.equal(line.includes('tenant-1'), false);
    assert.equal(line.includes('contact-1'), false);
  }
});

test('no-op emits nothing at all', () => {
  const emitted: string[] = [];
  const original = console.info;
  console.info = (line: unknown) => void emitted.push(String(line));
  try {
    noOpJourneyOwnerMetrics.increment('journey_owner_ack_escalated_total');
    noOpJourneyOwnerMetrics.observe('journey_owner_ack_attempts', 1);
  } finally {
    console.info = original;
  }
  assert.deepEqual(emitted, []);
});

/**
 * J2.8 (#136) — พิสูจน์ว่า observability ของ owner path ไม่พา PII หรือ identifier ออกไป
 *
 * metric backend มี retention ยาวกว่าและสิทธิ์เข้าถึงกว้างกว่าฐานข้อมูลมาก อะไรที่หลุดไป
 * ที่นั่นถือว่าหลุดถาวร — test ชุดนี้จึงตรวจ "สิ่งที่ถูกปล่อยออกไปจริง" ไม่ใช่แค่ว่า
 * interface หน้าตาถูกต้อง
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

/** ดัก console.info เพื่อดูสิ่งที่ปล่อยออกไปจริง */
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

test('ทุก metric ปล่อยเฉพาะ metric name กับ value ไม่มี key อื่นเลย', () => {
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
      `metric payload ต้องมีแค่ metric กับ value แต่ได้ ${line}`,
    );
    assert.equal(typeof parsed.metric, 'string');
    assert.equal(typeof parsed.value, 'number');
  }
});

test('ชื่อ metric ไม่มี identifier ฝังอยู่ในตัวเอง', () => {
  // ชื่อต้องเป็น snake_case คงที่เท่านั้น — ถ้ามีใคร interpolate id เข้าไปจะจับได้ตรงนี้
  for (const metric of [...COUNTERS, ...GAUGES]) {
    assert.match(metric, /^journey_owner_[a-z_]+$/, `ชื่อ metric ผิดรูป: ${metric}`);
  }
});

test('observe ไม่ปล่อยค่าติดลบออกไป', () => {
  const emitted = captureEmitted((metrics) => {
    metrics.observe('journey_owner_dispatch_to_result_ms', -5_000);
  });
  assert.equal((JSON.parse(emitted[0]!) as { value: number }).value, 0);
});

test('label ที่แอบส่งเข้ามาเกิน signature ก็ยังไม่หลุดออกไป', () => {
  // TypeScript กันไว้ที่ compile time แต่ JS ยอมให้ส่ง argument เกินได้เสมอ — โค้ดที่
  // ถูก transpile หรือเรียกจาก JS ตรง ๆ จึงยังแอบยัด label เข้ามาได้ ยืนยันว่าต่อให้
  // ยัดเข้ามาจริง payload ที่ปล่อยออกก็ยังมีแค่ metric กับ value
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

test('no-op ไม่ปล่อยอะไรออกไปเลย', () => {
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

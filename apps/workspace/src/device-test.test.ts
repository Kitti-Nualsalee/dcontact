import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDevicePreferenceStore,
  micConstraint,
  rememberedDeviceMissing,
  routeToSpeaker,
} from './device-preferences.js';
import { createSpeechDetector, micFailure, rmsLevel } from './device-test.js';

const LOUD = 0.2;
const SILENT = 0.001;

function feed(levels: (now: number) => number, untilMs: number, stepMs = 100) {
  const detector = createSpeechDetector();
  let result = detector.sample(levels(0), 0);
  for (let now = stepMs; now <= untilMs; now += stepMs) result = detector.sample(levels(now), now);
  return result;
}

test('ได้ยินเสียงพูดต่อเนื่องราว 1 วินาที → ผ่าน', () => {
  assert.equal(
    feed(() => LOUD, 1_000),
    'pass',
  );
  assert.equal(
    feed(() => LOUD, 800),
    'listening',
  );
});

test('หยุดหายใจสั้น ๆ ไม่ตัดเวลาที่พูด แต่เงียบนานกว่า 1.5 วินาทีเริ่มนับใหม่', () => {
  // พูด 0.6 วิ เว้น 0.4 วิ พูดต่อ 0.5 วิ → รวม ≥ 1 วิ
  assert.equal(
    feed((now) => (now < 600 || now >= 1_000 ? LOUD : SILENT), 1_500),
    'pass',
  );
  // พูด 0.6 วิ เงียบ 2 วิ พูดอีก 0.6 วิ → ยังไม่ผ่าน
  assert.equal(
    feed((now) => (now < 600 || now >= 2_600 ? LOUD : SILENT), 3_200),
    'listening',
  );
});

test('ไม่ได้ยินเสียง 8 วินาที → แจ้งว่าเงียบ แต่ถ้าพูดภายหลังยังผ่านได้ และผ่านแล้วคงผ่าน', () => {
  const detector = createSpeechDetector();
  let result = detector.sample(SILENT, 0);
  for (let now = 100; now <= 8_000; now += 100) result = detector.sample(SILENT, now);
  assert.equal(result, 'quiet');
  for (let now = 8_100; now <= 9_200; now += 100) result = detector.sample(LOUD, now);
  assert.equal(result, 'pass');
  assert.equal(detector.sample(SILENT, 20_000), 'pass');
});

test('RMS ของสัญญาณ', () => {
  assert.equal(rmsLevel([]), 0);
  assert.equal(rmsLevel([0.5, -0.5, 0.5, -0.5]), 0.5);
});

test('แปลง error ของ getUserMedia เป็นเหตุที่บอก Agent ได้', () => {
  const named = (name: string) => Object.assign(new Error(name), { name });
  assert.equal(micFailure(named('NotAllowedError')), 'denied');
  assert.equal(micFailure(named('NotFoundError')), 'notFound');
  assert.equal(micFailure(named('OverconstrainedError')), 'notFound');
  assert.equal(micFailure(named('NotReadableError')), 'busy');
  assert.equal(micFailure({ name: 'NotAllowedError' }), 'denied');
  assert.equal(micFailure('boom'), 'failed');
});

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

test('จำอุปกรณ์และผลทดสอบล่าสุด และแจ้ง subscriber', () => {
  const storage = memoryStorage();
  const store = createDevicePreferenceStore(() => storage);
  let calls = 0;
  store.subscribe(() => (calls += 1));
  store.setDevices({ micId: 'mic-1' });
  store.setDevices({ speakerId: 'spk-1' });
  store.setLastTest({ result: 'pass', at: '2026-11-21T02:00:00.000Z' });
  assert.equal(calls, 3);

  const reloaded = createDevicePreferenceStore(() => storage);
  assert.deepEqual(reloaded.devices(), { micId: 'mic-1', speakerId: 'spk-1' });
  assert.deepEqual(reloaded.lastTest(), { result: 'pass', at: '2026-11-21T02:00:00.000Z' });

  reloaded.setDevices({ micId: undefined });
  assert.deepEqual(reloaded.devices(), { speakerId: 'spk-1' });
});

test('storage เสียหายหรือใช้ไม่ได้ → ใช้ค่าเริ่มต้นและไม่ throw', () => {
  const broken = createDevicePreferenceStore(() =>
    memoryStorage({
      'dcontact.workspace.audioDevices': '{bad json',
      'dcontact.workspace.deviceTest': JSON.stringify({ result: 'maybe', at: 1 }),
    }),
  );
  assert.deepEqual(broken.devices(), {});
  assert.equal(broken.lastTest(), undefined);

  const blocked = createDevicePreferenceStore(() => {
    throw new Error('SecurityError');
  });
  blocked.setDevices({ micId: 'mic-1' });
  assert.deepEqual(blocked.devices(), { micId: 'mic-1' });
});

test('ไมค์ที่เลือกใช้ ideal ให้ browser ใช้ค่าเริ่มต้นเมื่ออุปกรณ์หาย', () => {
  assert.equal(micConstraint({}), true);
  assert.deepEqual(micConstraint({ micId: 'mic-1' }), { deviceId: { ideal: 'mic-1' } });
  const available = [{ deviceId: 'default' }, { deviceId: 'mic-1' }];
  assert.equal(rememberedDeviceMissing('mic-1', available), false);
  assert.equal(rememberedDeviceMissing('mic-2', available), true);
  assert.equal(rememberedDeviceMissing(undefined, available), false);
  assert.equal(rememberedDeviceMissing('default', []), false);
});

test('ส่งเสียงไปลำโพงที่เลือก, ลำโพงหายใช้ค่าเริ่มต้น, browser ไม่รองรับไม่ throw', async () => {
  const sinks: string[] = [];
  const element = {
    setSinkId: async (id: string) => {
      if (id === 'gone') throw new Error('NotFoundError');
      sinks.push(id);
    },
  } as unknown as HTMLMediaElement;
  assert.equal(await routeToSpeaker(element, 'spk-1'), 'applied');
  assert.equal(await routeToSpeaker(element, undefined), 'default');
  assert.equal(await routeToSpeaker(element, 'gone'), 'default');
  assert.deepEqual(sinks, ['spk-1', '', '']);
  assert.equal(await routeToSpeaker({} as HTMLMediaElement, 'spk-1'), 'unsupported');
});

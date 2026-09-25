import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserDphone, type BrowserSipTransport, type SipCredentialLease } from './dphone.js';

const lease: SipCredentialLease = {
  leaseId: 'lease-1',
  extension: '1000',
  authorizationUsername: '1000',
  authorizationPassword: 'secret',
  sipDomain: 'demo.d-contact.test',
  wssUrl: 'wss://fs-b.voice.test:7443',
  telephonyNodeId: 'fs-b',
  iceServers: [{ urls: ['turn:turn.voice.test:3478'] }],
  expiresAt: '2026-09-06T10:15:00.000Z',
};

function transport(overrides: Partial<BrowserSipTransport> = {}): BrowserSipTransport {
  return {
    configure: async () => undefined,
    register: async () => undefined,
    unregister: async () => undefined,
    accept: async () => undefined,
    reject: async () => undefined,
    hold: async () => undefined,
    resume: async () => undefined,
    sendDtmf: async () => undefined,
    hangup: async () => undefined,
    setMuted: () => undefined,
    ...overrides,
  };
}

test('working tab ที่ media พร้อม register SIP และ accept invitation เพียงครั้งเดียว', async () => {
  const calls: string[] = [];
  const softphone = new BrowserDphone(
    transport({
      configure: async (input) => void calls.push(`configure:${input.telephonyNodeId}`),
      register: async () => void calls.push('register'),
      accept: async () => void calls.push('accept'),
    }),
  );

  await softphone.start(lease, { ownsWorkingTab: true, mediaReady: true });
  softphone.receiveInvitation('interaction-1');
  await softphone.accept();
  await assert.rejects(softphone.accept(), /RINGING/);

  assert.deepEqual(calls, ['configure:fs-b', 'register', 'accept']);
  assert.deepEqual(softphone.current(), {
    phase: 'CONNECTING',
    interactionId: 'interaction-1',
    telephonyNodeId: 'fs-b',
  });
});

test('passive tab หรือ media ไม่พร้อมจะไม่ register และปฏิเสธ invitation', async () => {
  const calls: string[] = [];
  const softphone = new BrowserDphone(
    transport({
      configure: async () => void calls.push('configure'),
      register: async () => void calls.push('register'),
      reject: async () => void calls.push('reject'),
    }),
  );

  await softphone.start(lease, { ownsWorkingTab: false, mediaReady: true });
  await softphone.receiveInvitation('interaction-passive');

  assert.deepEqual(calls, ['reject']);
  assert.deepEqual(softphone.current(), { phase: 'OFFLINE' });
});

test('SIP reconnect ใช้ bounded backoff หกครั้งแล้วเปลี่ยนเป็น manual recovery', async () => {
  const delays: number[] = [];
  let attempts = 0;
  const softphone = new BrowserDphone(
    transport({
      register: async () => {
        attempts += 1;
        if (attempts > 1) throw new Error('transport unavailable');
      },
    }),
    { sleep: async (milliseconds) => void delays.push(milliseconds) },
  );
  await softphone.start(lease, { ownsWorkingTab: true, mediaReady: true });

  await softphone.registrationLost();

  assert.equal(attempts, 7);
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  assert.deepEqual(softphone.current(), {
    phase: 'RECOVERY_REQUIRED',
    telephonyNodeId: 'fs-b',
    attempts: 6,
  });
});

test('active call รองรับ local mute, hold/resume, DTMF และ hangup ตามลำดับ', async () => {
  const calls: string[] = [];
  const softphone = new BrowserDphone(
    transport({
      setMuted: (muted) => void calls.push(muted ? 'mute' : 'unmute'),
      hold: async () => void calls.push('hold'),
      resume: async () => void calls.push('resume'),
      sendDtmf: async (value) => void calls.push(`dtmf:${value}`),
      hangup: async () => void calls.push('hangup'),
    }),
  );
  await softphone.start(lease, { ownsWorkingTab: true, mediaReady: true });
  await softphone.receiveInvitation('interaction-controls');
  await softphone.accept();
  softphone.connected();

  softphone.setMuted(true);
  softphone.setMuted(false);
  await softphone.sendDtmf('5#');
  await softphone.hold();
  await softphone.resume();
  await softphone.hangup();

  assert.deepEqual(calls, ['mute', 'unmute', 'dtmf:5#', 'hold', 'resume', 'hangup']);
  assert.deepEqual(softphone.current(), {
    phase: 'READY',
    telephonyNodeId: 'fs-b',
  });
});

test('remote BYE จบ active Interaction เดิมและคืน softphone เป็น READY', async () => {
  const softphone = new BrowserDphone(transport());
  await softphone.start(lease, { ownsWorkingTab: true, mediaReady: true });
  await softphone.receiveInvitation('interaction-remote-bye');
  await softphone.accept();
  softphone.connected();

  assert.deepEqual(softphone.terminated(), {
    phase: 'READY',
    telephonyNodeId: 'fs-b',
  });
});

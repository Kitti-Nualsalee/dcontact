import assert from 'node:assert/strict';
import { createSocket, type BindOptions, type RemoteInfo, type Socket } from 'node:dgram';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import {
  startLocalRtpRelay,
  type LocalRtpRelay,
  type LocalRtpRelayDependencies,
} from './local-rtp-relay.js';

let fixtureNumber = 0;

async function bind(socket: Socket, port = 0): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind({ address: '127.0.0.1', port, exclusive: true }, () => {
      socket.off('error', reject);
      resolve();
    });
  });
}

async function send(socket: Socket, data: Buffer, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.send(data, port, '127.0.0.1', (error) => (error ? reject(error) : resolve()));
  });
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail('UDP fixture did not reach the expected state');
    await nextTurn();
  }
}

async function fixture(
  context: TestContext,
  hooks: {
    decorate?: (socket: Socket, backend: boolean) => void;
    backendBind?: (port: number, socket: Socket) => number | Error;
    failFrontPort?: number;
    backendBound?: (callback: () => void) => void;
  } = {},
) {
  const index = ++fixtureNumber;
  const config = {
    publicationAddress: `10.80.${index}.2`,
    relayMediaAddress: `10.81.${index}.2`,
    freeSwitchMediaAddress: `10.81.${index}.3`,
    publicationSubnet: `10.80.${index}.0/24`,
    mediaSubnet: `10.81.${index}.0/24`,
  };
  const backend = createSocket('udp4');
  const peers: Socket[] = [];
  const frontPorts = new Map<number, number>();
  const backendSockets: Socket[] = [];
  const frontSockets: Socket[] = [];
  const received: { data: Buffer; peer: RemoteInfo }[] = [];
  let now = 0;
  let sweep: (() => void) | undefined;
  let relay: LocalRtpRelay | undefined;
  await bind(backend);
  backend.on('message', (data, peer) => received.push({ data, peer }));
  const dependencies: LocalRtpRelayDependencies = {
    now: () => now,
    scheduleSweep: (callback, interval) => {
      assert.equal(interval, 5000);
      sweep = callback;
      return () => {
        sweep = undefined;
      };
    },
    createSocket: () => {
      const socket = createSocket({ type: 'udp4', reuseAddr: false });
      const nativeBind = socket.bind.bind(socket);
      const nativeConnect = socket.connect.bind(socket);
      const nativeEmit = socket.emit.bind(socket);
      let targetPort: number | undefined;
      let front = false;
      Object.assign(socket, {
        bind(options: BindOptions, callback: () => void) {
          front = options.address === config.publicationAddress;
          assert.ok(front || options.address === config.relayMediaAddress);
          assert.equal(options.exclusive, true);
          if (!front) backendSockets.push(socket);
          else frontSockets.push(socket);
          hooks.decorate?.(socket, !front);
          const candidate = front
            ? 0
            : (hooks.backendBind?.(options.port!, socket) ?? options.port);
          if (candidate instanceof Error || (front && options.port === hooks.failFrontPort)) {
            queueMicrotask(() =>
              socket.emit(
                'error',
                candidate instanceof Error
                  ? candidate
                  : Object.assign(new Error('fixture collision'), { code: 'EADDRINUSE' }),
              ),
            );
            return socket;
          }
          return nativeBind({ ...options, address: '127.0.0.1', port: candidate }, () => {
            if (front) frontPorts.set(options.port!, socket.address().port);
            if (!front && hooks.backendBound) hooks.backendBound(callback);
            else callback();
          });
        },
        connect(port: number, address: string, callback: () => void) {
          assert.equal(address, config.freeSwitchMediaAddress);
          assert.ok(port >= 16384 && port <= 16420);
          targetPort = port;
          return nativeConnect(backend.address().port, '127.0.0.1', callback);
        },
        emit(event: string, ...values: unknown[]) {
          if (event === 'message' && !front) {
            const peer = values[1] as RemoteInfo;
            values[1] = { ...peer, address: config.freeSwitchMediaAddress, port: targetPort };
          }
          return nativeEmit(event, ...values);
        },
      });
      return socket;
    },
  };
  context.after(async () => {
    if (relay) await relay.close();
    for (const socket of [...peers, backend]) {
      try {
        socket.close();
      } catch {}
    }
  });
  return {
    config,
    dependencies,
    backend,
    backendSockets,
    frontSockets,
    received,
    frontPorts,
    async start() {
      relay = await startLocalRtpRelay(config, dependencies);
      return relay;
    },
    async peer() {
      const socket = createSocket('udp4');
      peers.push(socket);
      await bind(socket);
      const messages: { data: Buffer; peer: RemoteInfo }[] = [];
      socket.on('message', (data, peer) => messages.push({ data, peer }));
      return { socket, messages };
    },
    advance(milliseconds: number) {
      now += milliseconds;
      sweep?.();
    },
    hasSweep: () => sweep !== undefined,
  };
}

test('local RTP relay รักษา datagram และ return path ผ่าน connected backend socket เดิม', async (context) => {
  const setup = await fixture(context);
  const relay = await setup.start();
  assert.equal(relay.snapshot().ready, true);
  assert.equal(relay.snapshot().boundPortCount, 37);
  const peer = await setup.peer();
  const frontPort = setup.frontPorts.get(16384)!;
  const payload = Buffer.from([0, 255, 7, 0, 42]);
  await send(peer.socket, payload, frontPort);
  await until(() => setup.received.length === 1);
  assert.deepEqual(setup.received[0].data, payload);
  const backendPeer = setup.received[0].peer;
  await send(setup.backend, Buffer.from('reply-one'), backendPeer.port);
  await send(setup.backend, Buffer.from('reply-two'), backendPeer.port);
  await until(() => peer.messages.length === 2);
  assert.deepEqual(
    peer.messages.map((message) => message.data.toString()),
    ['reply-one', 'reply-two'],
  );
  assert.ok(peer.messages.every((message) => message.peer.port === frontPort));
  await send(peer.socket, Buffer.from('next-datagram'), frontPort);
  await until(() => setup.received.length === 2);
  assert.equal(setup.received[1].peer.port, backendPeer.port);
  assert.equal(relay.snapshot().flowCount, 1);
  assert.equal(relay.snapshot().forwardedDatagrams, 4);
  await relay.close();
  assert.equal(setup.hasSweep(), false);
  assert.equal(relay.snapshot().boundPortCount, 0);
  assert.equal(relay.snapshot().flowCount, 0);
});

test('แยกสอง peers และสอง front ports โดยไม่เปลี่ยน destination จาก payload', async (context) => {
  const setup = await fixture(context);
  const relay = await setup.start();
  const first = await setup.peer();
  const second = await setup.peer();
  for (const [peer, port, message] of [
    [first, 16384, 'target=1.2.3.4:8021'],
    [second, 16384, 'second'],
    [first, 16385, 'third'],
  ] as const) {
    await send(peer.socket, Buffer.from(message), setup.frontPorts.get(port)!);
    await until(() => setup.received.some((entry) => entry.data.toString() === message));
  }
  assert.equal(new Set(setup.received.map((entry) => entry.peer.port)).size, 3);
  for (const entry of setup.received) await send(setup.backend, entry.data, entry.peer.port);
  await until(() => first.messages.length === 2 && second.messages.length === 1);
  assert.deepEqual(first.messages.map((entry) => entry.data.toString()).sort(), [
    'target=1.2.3.4:8021',
    'third',
  ]);
  assert.equal(second.messages[0].data.toString(), 'second');
  assert.equal(relay.snapshot().flowCount, 3);
});

test('expiry ไม่คืน backend port และ delayed packet เข้า flow ใหม่ไม่ได้', async (context) => {
  const setup = await fixture(context);
  const relay = await setup.start();
  const peer = await setup.peer();
  const front = setup.frontPorts.get(16384)!;
  await send(peer.socket, Buffer.from('old'), front);
  await until(() => setup.received.length === 1);
  const oldPort = setup.received[0].peer.port;
  setup.advance(120000);
  await until(() => relay.snapshot().flowCount === 0);
  await send(peer.socket, Buffer.from('new'), front);
  await until(() => setup.received.length === 2);
  const newPort = setup.received[1].peer.port;
  assert.notEqual(oldPort, newPort);
  await send(setup.backend, Buffer.from('delayed'), oldPort);
  await send(setup.backend, Buffer.from('current'), newPort);
  await until(() => peer.messages.length === 1);
  assert.equal(peer.messages[0].data.toString(), 'current');
  assert.equal(relay.snapshot().usedBackendPortCount >= 2, true);
});

test('บังคับ transport คืน port เก่าแล้วต้อง fail closed ก่อน forward', async (context) => {
  let reused: number | undefined;
  let force = false;
  const setup = await fixture(context, { backendBind: (port) => (force ? reused! : port) });
  const relay = await setup.start();
  const peer = await setup.peer();
  const front = setup.frontPorts.get(16384)!;
  await send(peer.socket, Buffer.from('old'), front);
  await until(() => setup.received.length === 1);
  reused = setup.received[0].peer.port;
  setup.advance(120000);
  await nextTurn();
  force = true;
  await send(peer.socket, Buffer.from('new'), front);
  await until(() => relay.snapshot().droppedDatagrams > 0 && relay.snapshot().flowCount === 0);
  await send(setup.backend, Buffer.from('delayed'), reused);
  await nextTurn();
  assert.equal(setup.received.length, 1);
  assert.equal(peer.messages.length, 0);
});

test('connected backend ปฏิเสธ rogue source และไม่ต่อ idle lifetime', async (context) => {
  const setup = await fixture(context);
  const relay = await setup.start();
  const peer = await setup.peer();
  const rogue = await setup.peer();
  await send(peer.socket, Buffer.from('first'), setup.frontPorts.get(16384)!);
  await until(() => setup.received.length === 1);
  setup.advance(119999);
  await send(rogue.socket, Buffer.from('rogue'), setup.received[0].peer.port);
  await nextTurn();
  setup.advance(1);
  assert.equal(relay.snapshot().flowCount, 0);
  assert.equal(peer.messages.length, 0);
});

test('per-port 8 และ global 128 flows ไม่ evict active flow', async (context) => {
  const setup = await fixture(context);
  const relay = await setup.start();
  const peers = await Promise.all(Array.from({ length: 9 }, () => setup.peer()));
  for (let port = 16384; port < 16400; port++) {
    for (const peer of peers.slice(0, 8)) {
      const count = setup.received.length;
      await send(peer.socket, Buffer.from('flow'), setup.frontPorts.get(port)!);
      await until(() => setup.received.length === count + 1);
    }
    if (port === 16384) {
      await send(peers[8].socket, Buffer.from('per-port overflow'), setup.frontPorts.get(port)!);
      await until(() => relay.snapshot().droppedDatagrams === 1);
      assert.equal(relay.snapshot().flowCount, 8);
    }
  }
  assert.equal(relay.snapshot().flowCount, 128);
  await send(peers[8].socket, Buffer.from('overflow'), setup.frontPorts.get(16384)!);
  await send(peers[0].socket, Buffer.from('overflow'), setup.frontPorts.get(16400)!);
  await until(() => relay.snapshot().droppedDatagrams >= 3);
  assert.equal(relay.snapshot().flowCount, 128);
  setup.advance(120000);
  assert.equal(relay.snapshot().flowCount, 0);
  await send(peers[8].socket, Buffer.from('released'), setup.frontPorts.get(16384)!);
  await until(() => setup.received.length === 129);
  assert.equal(relay.snapshot().flowCount, 1);
});

test('16 collisions ต่อ flow และใช้ครบ4096แล้วปฏิเสธ flow ใหม่จน process restart', async (context) => {
  const candidates: number[] = [];
  const setup = await fixture(context, {
    backendBind: (port) => {
      candidates.push(port);
      return Object.assign(new Error('fixture collision'), { code: 'EADDRINUSE' });
    },
  });
  const relay = await setup.start();
  const peer = await setup.peer();
  for (let round = 0; round < 256; round++) {
    await send(peer.socket, Buffer.from('collision'), setup.frontPorts.get(16384)!);
    await until(() => relay.snapshot().flowCount === 0 && candidates.length === (round + 1) * 16);
  }
  assert.equal(new Set(candidates).size, 4096);
  assert.equal(relay.snapshot().backendPortAllocationExhausted, true);
  const dropped = relay.snapshot().droppedDatagrams;
  await send(peer.socket, Buffer.from('exhausted'), setup.frontPorts.get(16384)!);
  await until(() => relay.snapshot().droppedDatagrams > dropped);
  assert.equal(candidates.length, 4096);
  await relay.close();
  const restarted = await setup.start();
  assert.equal(restarted.snapshot().usedBackendPortCount, 4096);
  assert.equal(restarted.snapshot().backendPortAllocationExhausted, true);
});

test('partial front bind failure ปิดทุก socket และไม่ตั้ง sweep', async (context) => {
  const sockets: Socket[] = [];
  const setup = await fixture(context, {
    failFrontPort: 16390,
    decorate: (socket) => {
      sockets.push(socket);
    },
  });
  await assert.rejects(setup.start(), { message: 'LOCAL_RTP_START_FAILED' });
  assert.equal(setup.hasSweep(), false);
  for (const socket of sockets) assert.throws(() => socket.address());
});

test('config ที่ผิดถูกปฏิเสธก่อนสร้าง socket', async (context) => {
  const setup = await fixture(context);
  const invalid = [
    { ...setup.config, extra: true },
    { ...setup.config, publicationAddress: '0.0.0.0' },
    { ...setup.config, freeSwitchMediaAddress: '10.81.1.4' },
    { ...setup.config, publicationSubnet: '10.80.1.1/24' },
    { ...setup.config, mediaSubnet: setup.config.publicationSubnet },
    { ...setup.config, mediaSubnet: '127.0.0.0/24' },
    { ...setup.config, mediaSubnet: '10.81.1.0/30' },
    { ...setup.config, mediaSubnet: '10.81.1.0/024' },
  ];
  for (const config of invalid)
    await assert.rejects(
      startLocalRtpRelay(config, {
        createSocket: () => {
          assert.fail('invalid config created a socket');
        },
      }),
      { message: 'INVALID_LOCAL_RTP_CONFIGURATION' },
    );
});

test('setup burst มี backend เดียวและ close ระหว่าง bind ไม่ทิ้ง socket', async (context) => {
  let bound: (() => void) | undefined;
  const setup = await fixture(context, {
    backendBound: (callback) => {
      bound = callback;
    },
  });
  const relay = await setup.start();
  const peer = await setup.peer();
  const front = setup.frontPorts.get(16384)!;
  await send(peer.socket, Buffer.from('held'), front);
  await until(() => bound !== undefined);
  for (let index = 0; index < 20; index++) await send(peer.socket, Buffer.from('burst'), front);
  await until(() => relay.snapshot().droppedDatagrams === 20);
  assert.equal(setup.backendSockets.length, 1);
  assert.equal(relay.snapshot().pendingDatagrams, 1);
  const closing = relay.close();
  assert.equal(relay.close(), closing);
  assert.equal(relay.snapshot().pendingBytes, 0);
  bound!();
  await closing;
  assert.equal(setup.received.length, 0);
  assert.throws(() => setup.backendSockets[0].address());
});

test('pending send budget จำกัด256 datagrams และคืน counters เมื่อ callback/close', async (context) => {
  const completions: (() => void)[] = [];
  const setup = await fixture(context, {
    decorate: (socket, backend) => {
      if (!backend) return;
      const nativeSend = socket.send.bind(socket);
      Object.assign(socket, {
        send(data: Buffer, callback: (error: Error | null) => void) {
          return nativeSend(data, (error) => completions.push(() => callback(error)));
        },
      });
    },
  });
  const relay = await setup.start();
  const peer = await setup.peer();
  for (let index = 0; index < 256; index++) {
    await send(peer.socket, Buffer.from('held'), setup.frontPorts.get(16384)!);
    await until(() => relay.snapshot().pendingDatagrams === index + 1);
  }
  await send(peer.socket, Buffer.from('overflow'), setup.frontPorts.get(16384)!);
  await until(() => relay.snapshot().droppedDatagrams === 1);
  assert.equal(relay.snapshot().pendingBytes, 1024);
  await until(() => completions.length === 256);
  completions[0]();
  assert.equal(relay.snapshot().pendingDatagrams, 255);
  await relay.close();
  assert.equal(relay.snapshot().pendingDatagrams, 0);
  assert.equal(relay.snapshot().pendingBytes, 0);
  for (const complete of completions) complete();
  assert.equal(relay.snapshot().pendingDatagrams, 0);
});

test('injected transport pressure จำกัด4MiB และ backend error คืน flow/budget', async (context) => {
  let started = 0;
  const setup = await fixture(context, {
    decorate: (socket, backend) => {
      if (!backend) return;
      Object.assign(socket, {
        send() {
          started++;
          return socket;
        },
      });
    },
  });
  const relay = await setup.start();
  const peer = await setup.peer();
  const payload = Buffer.alloc(65507, 7);
  for (let index = 0; index < 64; index++) {
    setup.frontSockets[0].emit('message', payload, {
      ...peer.socket.address(),
      size: payload.length,
    });
    await until(() => started === index + 1 && relay.snapshot().pendingDatagrams === index + 1);
  }
  setup.frontSockets[0].emit('message', payload, {
    ...peer.socket.address(),
    size: payload.length,
  });
  await until(() => relay.snapshot().droppedDatagrams === 1);
  assert.equal(relay.snapshot().pendingBytes, 64 * 65507);
  setup.backendSockets[0].emit('error', new Error('synthetic failure'));
  assert.equal(relay.snapshot().flowCount, 0);
  assert.equal(relay.snapshot().pendingBytes, 0);
});

test('valid backend activity ต่อ idle แต่ stale callbacks ไม่กระทบ flow ใหม่', async (context) => {
  const setup = await fixture(context);
  const relay = await setup.start();
  const peer = await setup.peer();
  const front = setup.frontPorts.get(16384)!;
  await send(peer.socket, Buffer.from('first'), front);
  await until(() => setup.received.length === 1);
  const oldBackend = setup.backendSockets.at(-1)!;
  setup.advance(119999);
  await send(setup.backend, Buffer.from('keepalive'), setup.received[0].peer.port);
  await until(() => peer.messages.length === 1);
  setup.advance(1);
  assert.equal(relay.snapshot().flowCount, 1);
  setup.advance(119999);
  assert.equal(relay.snapshot().flowCount, 0);
  await send(peer.socket, Buffer.from('new'), front);
  await until(() => setup.received.length === 2);
  oldBackend.emit('error', new Error('stale failure'));
  assert.equal(relay.snapshot().flowCount, 1);
  assert.equal(peer.messages.length, 1);
});

test('front runtime failure ปิดทั้ง adapter ไม่คง partial-ready', async (context) => {
  const setup = await fixture(context);
  const relay = await setup.start();
  setup.frontSockets[0].emit('error', new Error('synthetic failure'));
  assert.equal(relay.snapshot().ready, false);
  assert.equal(relay.snapshot().failureCode, 'FRONT_SOCKET_FAILED');
  await relay.close();
  assert.equal(relay.snapshot().boundPortCount, 0);
  assert.equal(setup.hasSweep(), false);
});

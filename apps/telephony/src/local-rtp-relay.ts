import { createSocket, type Socket, type RemoteInfo } from 'node:dgram';

export type LocalRtpRelayConfig = {
  publicationAddress: string;
  relayMediaAddress: string;
  freeSwitchMediaAddress: string;
  publicationSubnet: string;
  mediaSubnet: string;
};

export type LocalRtpRelayDependencies = {
  createSocket(): Socket;
  now(): number;
  scheduleSweep(callback: () => void, interval: number): () => void;
};

export type LocalRtpRelay = {
  close(): Promise<void>;
  snapshot(): {
    ready: boolean;
    boundPortCount: number;
    flowCount: number;
    forwardedDatagrams: number;
    droppedDatagrams: number;
    pendingDatagrams: number;
    pendingBytes: number;
    usedBackendPortCount: number;
    backendPortAllocationExhausted: boolean;
    failureCode: 'FRONT_SOCKET_FAILED' | null;
  };
};

const allocations = new Map<string, { next: number; used: Set<number> }>();

function ipv4(value: string): number {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) {
    throw new Error('INVALID_LOCAL_RTP_CONFIGURATION');
  }
  const octets = value.split('.').map(Number);
  if (octets.some((octet) => octet > 255)) {
    throw new Error('INVALID_LOCAL_RTP_CONFIGURATION');
  }
  return octets.reduce((address, octet) => address * 256 + octet, 0);
}

function subnet(value: string): { network: number; size: number } {
  const match = /^(.*)\/(\d|[12]\d|3[0-2])$/.exec(value);
  if (!match) throw new Error('INVALID_LOCAL_RTP_CONFIGURATION');
  const network = ipv4(match[1]);
  const size = 2 ** (32 - Number(match[2]));
  const end = network + size - 1;
  const privateRanges = [
    [0x0a000000, 0x0affffff],
    [0xac100000, 0xac1fffff],
    [0xc0a80000, 0xc0a8ffff],
  ];
  if (
    size < 8 ||
    network % size !== 0 ||
    !privateRanges.some(([first, last]) => network >= first && end <= last)
  )
    throw new Error('INVALID_LOCAL_RTP_CONFIGURATION');
  return { network, size };
}

function validate(config: LocalRtpRelayConfig): void {
  const fields = [
    'publicationAddress',
    'relayMediaAddress',
    'freeSwitchMediaAddress',
    'publicationSubnet',
    'mediaSubnet',
  ];
  if (
    !config ||
    Object.keys(config).length !== fields.length ||
    !fields.every(
      (field) =>
        Object.hasOwn(config, field) &&
        typeof config[field as keyof LocalRtpRelayConfig] === 'string',
    )
  ) {
    throw new Error('INVALID_LOCAL_RTP_CONFIGURATION');
  }
  const publication = subnet(config.publicationSubnet);
  const media = subnet(config.mediaSubnet);
  if (
    (publication.network < media.network + media.size &&
      media.network < publication.network + publication.size) ||
    ipv4(config.publicationAddress) !== publication.network + 2 ||
    ipv4(config.relayMediaAddress) !== media.network + 2 ||
    ipv4(config.freeSwitchMediaAddress) !== media.network + 3
  )
    throw new Error('INVALID_LOCAL_RTP_CONFIGURATION');
}

export async function startLocalRtpRelay(
  config: LocalRtpRelayConfig,
  overrides: Partial<LocalRtpRelayDependencies> = {},
): Promise<LocalRtpRelay> {
  validate(config);
  const dependencies: LocalRtpRelayDependencies = {
    createSocket: () => createSocket({ type: 'udp4', reuseAddr: false }),
    now: () => performance.now(),
    scheduleSweep: (callback, interval) => {
      const timer = setInterval(callback, interval);
      timer.unref();
      return () => clearInterval(timer);
    },
    ...overrides,
  };
  let allocation = allocations.get(config.relayMediaAddress);
  if (!allocation) {
    allocation = { next: 49152, used: new Set() };
    allocations.set(config.relayMediaAddress, allocation);
  }
  const ports = allocation;
  type Tracked = { socket: Socket; binding: boolean; closing: boolean; closed: boolean };
  type Flow = {
    key: string;
    front: Socket;
    port: number;
    peer: RemoteInfo;
    lastActivity: number;
    connected: boolean;
    backend?: Tracked;
    releases: Set<() => void>;
  };
  const sockets = new Set<Tracked>();
  const fronts = new Set<Tracked>();
  const flows = new Map<string, Flow>();
  const portCounts = new Map<number, number>();
  let ready = false;
  let closing = false;
  let forwardedDatagrams = 0;
  let droppedDatagrams = 0;
  let pendingDatagrams = 0;
  let pendingBytes = 0;
  let failureCode: 'FRONT_SOCKET_FAILED' | null = null;
  let cancelSweep: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;
  let finishClose: (() => void) | undefined;

  function closeSocket(tracked: Tracked): void {
    tracked.closing = true;
    if (tracked.closed || tracked.binding) return;
    try {
      tracked.socket.close();
    } catch {
      tracked.closed = true;
      sockets.delete(tracked);
      fronts.delete(tracked);
      if (sockets.size === 0) finishClose?.();
    }
  }

  function track(socket: Socket, onError: () => void): Tracked {
    const tracked: Tracked = { socket, binding: false, closing: false, closed: false };
    sockets.add(tracked);
    socket.on('close', () => {
      tracked.closed = true;
      sockets.delete(tracked);
      fronts.delete(tracked);
      if (!tracked.closing) onError();
      if (sockets.size === 0) finishClose?.();
    });
    socket.on('error', () => {
      tracked.binding = false;
      onError();
      if (tracked.closing) closeSocket(tracked);
    });
    return tracked;
  }

  function removeFlow(flow: Flow): void {
    if (flows.get(flow.key) !== flow) return;
    flows.delete(flow.key);
    portCounts.set(flow.port, (portCounts.get(flow.port) ?? 1) - 1);
    for (const release of flow.releases) release();
    if (flow.backend) closeSocket(flow.backend);
  }

  function reserve(flow: Flow, bytes: number): (() => void) | undefined {
    if (pendingDatagrams >= 256 || pendingBytes + bytes > 4 * 1024 * 1024) return;
    pendingDatagrams++;
    pendingBytes += bytes;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      pendingDatagrams--;
      pendingBytes -= bytes;
      flow.releases.delete(release);
    };
    flow.releases.add(release);
    return release;
  }

  function forward(flow: Flow, data: Buffer, release: () => void, backend: boolean): void {
    const complete = (error: Error | null) => {
      release();
      if (flows.get(flow.key) !== flow || closing) return;
      if (error) {
        droppedDatagrams++;
        removeFlow(flow);
      } else forwardedDatagrams++;
    };
    try {
      if (backend) flow.backend!.socket.send(data, complete);
      else flow.front.send(data, flow.peer.port, flow.peer.address, complete);
    } catch {
      complete(new Error('SEND_FAILED'));
    }
  }

  async function bindSocket(tracked: Tracked, address: string, port: number): Promise<void> {
    tracked.binding = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => {
          tracked.socket.off('listening', listening);
          reject(error);
        };
        const listening = () => {
          tracked.socket.off('error', failed);
          resolve();
        };
        tracked.socket.once('error', failed);
        try {
          tracked.socket.bind({ address, port, exclusive: true }, listening);
        } catch (error) {
          tracked.socket.off('error', failed);
          reject(error);
        }
      });
    } finally {
      tracked.binding = false;
      if (tracked.closing) closeSocket(tracked);
    }
  }

  async function initialize(flow: Flow, data: Buffer, release: () => void): Promise<void> {
    try {
      for (let attempt = 0; attempt < 16 && ports.next <= 53247; attempt++) {
        if (closing || flows.get(flow.key) !== flow) return;
        const candidate = ports.next++;
        ports.used.add(candidate);
        let initializing = true;
        const tracked = track(dependencies.createSocket(), () => {
          if (!initializing) removeFlow(flow);
        });
        flow.backend = tracked;
        try {
          await bindSocket(tracked, config.relayMediaAddress, candidate);
        } catch (error) {
          closeSocket(tracked);
          if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
          throw error;
        }
        if (closing || flows.get(flow.key) !== flow) {
          closeSocket(tracked);
          return;
        }
        if (tracked.socket.address().port !== candidate) throw new Error('BACKEND_PORT_MISMATCH');
        tracked.socket.on('message', (reply: Buffer, peer: RemoteInfo) => {
          if (closing || flows.get(flow.key) !== flow || !flow.connected) return;
          if (
            peer.address !== config.freeSwitchMediaAddress ||
            peer.port !== flow.port ||
            reply.length > 65507
          ) {
            droppedDatagrams++;
            return;
          }
          flow.lastActivity = dependencies.now();
          const replyRelease = reserve(flow, reply.length);
          if (!replyRelease) {
            droppedDatagrams++;
            return;
          }
          forward(flow, reply, replyRelease, false);
        });
        await new Promise<void>((resolve, reject) => {
          const failed = () => {
            tracked.socket.off('close', failed);
            reject(new Error('BACKEND_CONNECT_FAILED'));
          };
          tracked.socket.once('error', failed);
          tracked.socket.once('close', failed);
          try {
            tracked.socket.connect(flow.port, config.freeSwitchMediaAddress, () => {
              tracked.socket.off('error', failed);
              tracked.socket.off('close', failed);
              resolve();
            });
          } catch {
            tracked.socket.off('error', failed);
            tracked.socket.off('close', failed);
            reject(new Error('BACKEND_CONNECT_FAILED'));
          }
        });
        initializing = false;
        if (closing || flows.get(flow.key) !== flow) {
          closeSocket(tracked);
          return;
        }
        flow.connected = true;
        forward(flow, data, release, true);
        return;
      }
      droppedDatagrams++;
      removeFlow(flow);
    } catch {
      droppedDatagrams++;
      removeFlow(flow);
    } finally {
      if (flows.get(flow.key) !== flow) release();
    }
  }

  const relay: LocalRtpRelay = {
    close() {
      if (closePromise) return closePromise;
      closing = true;
      ready = false;
      cancelSweep?.();
      closePromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('LOCAL_RTP_SHUTDOWN_TIMEOUT')), 2000);
        finishClose = () => {
          clearTimeout(timeout);
          resolve();
        };
        for (const flow of [...flows.values()]) removeFlow(flow);
        for (const tracked of sockets) closeSocket(tracked);
        if (sockets.size === 0) finishClose();
      });
      return closePromise;
    },
    snapshot: () => ({
      ready,
      boundPortCount: fronts.size,
      flowCount: flows.size,
      forwardedDatagrams,
      droppedDatagrams,
      pendingDatagrams,
      pendingBytes,
      usedBackendPortCount: ports.used.size,
      backendPortAllocationExhausted: ports.next > 53247,
      failureCode,
    }),
  };

  try {
    for (let port = 16384; port <= 16420; port++) {
      const tracked = track(dependencies.createSocket(), () => {
        failureCode = 'FRONT_SOCKET_FAILED';
        void relay.close().catch(() => undefined);
      });
      await bindSocket(tracked, config.publicationAddress, port);
      if (closing) throw new Error('FRONT_SOCKET_FAILED');
      fronts.add(tracked);
      tracked.socket.on('message', (data: Buffer, peer: RemoteInfo) => {
        let address: number;
        try {
          address = ipv4(peer.address);
        } catch {
          droppedDatagrams++;
          return;
        }
        if (
          !ready ||
          closing ||
          peer.family !== 'IPv4' ||
          peer.port < 1 ||
          peer.port > 65535 ||
          address < 0x01000000 ||
          address >= 0xe0000000 ||
          address === 0xffffffff ||
          data.length > 65507
        ) {
          droppedDatagrams++;
          return;
        }
        const key = `${port}/${peer.address}/${peer.port}`;
        let flow = flows.get(key);
        if (flow) {
          flow.lastActivity = dependencies.now();
          if (!flow.connected) {
            droppedDatagrams++;
            return;
          }
          const release = reserve(flow, data.length);
          if (!release) {
            droppedDatagrams++;
            return;
          }
          forward(flow, data, release, true);
          return;
        }
        if (flows.size >= 128 || (portCounts.get(port) ?? 0) >= 8 || ports.next > 53247) {
          droppedDatagrams++;
          return;
        }
        flow = {
          key,
          front: tracked.socket,
          port,
          peer: { ...peer },
          lastActivity: dependencies.now(),
          connected: false,
          releases: new Set(),
        };
        const release = reserve(flow, data.length);
        if (!release) {
          droppedDatagrams++;
          return;
        }
        flows.set(key, flow);
        portCounts.set(port, (portCounts.get(port) ?? 0) + 1);
        void initialize(flow, data, release);
      });
    }
    cancelSweep = dependencies.scheduleSweep(() => {
      const now = dependencies.now();
      for (const flow of flows.values()) if (now - flow.lastActivity >= 120000) removeFlow(flow);
    }, 5000);
    ready = true;
    return relay;
  } catch {
    await relay.close();
    throw new Error('LOCAL_RTP_START_FAILED');
  }
}

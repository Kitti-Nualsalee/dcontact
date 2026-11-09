import {
  PORT_NAME,
  parseExtensionRequest,
  type ExtensionMessage,
  type ExtensionRequest,
} from '../dphone/extension-protocol.js';
import { SipJsBrowserTransport } from '../dphone/sip-js-transport.js';
import { browser, type PhonePort } from './chrome.js';

export type PhoneStatus =
  'waiting' | 'connecting' | 'ready' | 'ringing' | 'active' | 'lost' | 'duplicate';

export function attachPhoneRuntime(options: {
  origin: string;
  audio: HTMLAudioElement;
  microphoneReady(): boolean;
  onStatus(status: PhoneStatus): void;
  onWorkspaceTab(tabId: number | undefined): void;
  onAudioBlocked(blocked: boolean): void;
}): () => void {
  let release: (() => void) | undefined;
  let closed = false;
  let active: { disconnect(): void } | undefined;

  const onConnect = (port: PhonePort) => {
    const sender = port.sender;
    if (
      closed ||
      active ||
      !options.microphoneReady() ||
      port.name !== PORT_NAME ||
      !sender ||
      sender.id ||
      sender.frameId !== 0 ||
      sender.origin !== options.origin ||
      sender.tab?.id === undefined
    ) {
      port.disconnect();
      return;
    }

    let connected = true;
    let configured = false;
    let registered = false;
    let call: 'idle' | 'ringing' | 'active' = 'idle';
    let callId = 0;
    let work = Promise.resolve();
    let lastId = 0;
    const connection = { disconnect };
    active = connection;
    const send = (message: ExtensionMessage) => {
      if (!connected) return;
      try {
        port.postMessage(message);
      } catch {
        disconnect();
      }
    };
    const transport = new SipJsBrowserTransport(options.audio, {
      onInvitation: () => {
        if (!connected || !registered) {
          void transport.reject().catch(() => undefined);
          return;
        }
        callId += 1;
        call = 'ringing';
        options.onStatus('ringing');
        send({ type: 'event', event: 'invitation', callId });
      },
      onSessionEstablished: () => {
        if (!connected) return;
        call = 'active';
        options.onStatus('active');
        send({ type: 'event', event: 'established', callId });
      },
      onSessionTerminated: () => {
        const hadCall = call !== 'idle';
        call = 'idle';
        if (!connected || !hadCall) return;
        options.onAudioBlocked(false);
        options.onStatus(registered ? 'ready' : 'lost');
        send({ type: 'event', event: 'terminated', callId });
      },
      onRegistrationLost: () => {
        if (!connected || !registered) return;
        registered = false;
        options.onStatus('lost');
        send({ type: 'event', event: 'registrationLost' });
      },
      onAutoplayBlocked: () => {
        if (!connected) return;
        options.onAudioBlocked(true);
        send({ type: 'event', event: 'autoplayBlocked' });
      },
    });

    async function handle(request: ExtensionRequest) {
      if (!connected) return;
      try {
        if ('callId' in request && request.callId !== callId) throw new Error('Call changed');
        switch (request.command) {
          case 'configure':
            if (configured || Date.parse(request.lease.expiresAt) <= Date.now()) {
              throw new Error('Invalid SIP configuration');
            }
            await transport.configure(request.lease);
            configured = true;
            break;
          case 'register':
            if (!configured) throw new Error('Missing SIP configuration');
            if (registered) break;
            await transport.register();
            registered = true;
            options.onStatus(call === 'idle' ? 'ready' : call);
            break;
          case 'accept':
            if (!registered || call !== 'ringing') throw new Error('No incoming call');
            await transport.accept();
            break;
          case 'hangup':
            if (call !== 'active') throw new Error('No active call');
            await transport.hangup();
            break;
          case 'reject':
            if (call !== 'ringing') throw new Error('No incoming call');
            await transport.reject();
            break;
          case 'unregister':
            registered = false;
            configured = false;
            await transport.unregister();
            break;
        }
        send({ type: 'reply', id: request.id, ok: true });
        if (request.command === 'unregister') disconnect();
      } catch {
        if (!connected) return;
        if (request.command === 'register' || request.command === 'configure') {
          options.onStatus('lost');
        }
        send({ type: 'reply', id: request.id, ok: false });
      }
    }

    function onMessage(value: unknown) {
      const request = parseExtensionRequest(value);
      if (!request || request.id <= lastId) {
        disconnect();
        return;
      }
      lastId = request.id;
      work = work.then(() => handle(request));
    }

    function disconnect() {
      if (!connected) return;
      connected = false;
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(disconnect);
      port.disconnect();
      options.onWorkspaceTab(undefined);
      options.onAudioBlocked(false);
      options.onStatus('waiting');
      // Hold ownership until the old SIP user agent has stopped.
      void work
        .then(() => transport.unregister())
        .then(() => {
          if (active === connection) active = undefined;
        })
        .catch(() => options.onStatus('lost'));
    }

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(disconnect);
    options.onWorkspaceTab(sender.tab.id);
    options.onStatus('connecting');
    send({ type: 'ready' });
  };

  // Only one extension document may own SIP, including manually duplicated tabs.
  void navigator.locks.request('d-phone-owner', { ifAvailable: true }, async (lock) => {
    if (closed) return;
    if (!lock) {
      options.onStatus('duplicate');
      return;
    }
    browser.runtime.onConnectExternal.addListener(onConnect);
    try {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    } finally {
      browser.runtime.onConnectExternal.removeListener(onConnect);
    }
  });
  return () => {
    closed = true;
    active?.disconnect();
    release?.();
  };
}

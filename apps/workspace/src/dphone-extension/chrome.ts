import type { ExtensionMessage } from '../dphone/extension-protocol.js';

type ChromeListener<Args extends unknown[]> = {
  addListener(listener: (...args: Args) => void): void;
  removeListener(listener: (...args: Args) => void): void;
};

type PhoneTab = { id?: number; windowId: number };

export type PhonePort = {
  name: string;
  sender?: { origin?: string; url?: string; id?: string; frameId?: number; tab?: PhoneTab };
  postMessage(message: ExtensionMessage): void;
  disconnect(): void;
  onMessage: ChromeListener<[unknown]>;
  onDisconnect: ChromeListener<[]>;
};

export const browser = (
  globalThis as unknown as {
    chrome: {
      runtime: {
        getURL(path: string): string;
        getContexts(filter: {
          contextTypes: ['TAB'];
          documentUrls: string[];
        }): Promise<{ tabId: number }[]>;
        onConnectExternal: ChromeListener<[PhonePort]>;
      };
      action: { onClicked: ChromeListener<[]> };
      tabs: {
        create(properties: { url: string }): Promise<PhoneTab>;
        update(id: number, properties: { active: true }): Promise<PhoneTab | undefined>;
      };
      windows: { update(id: number, properties: { focused: true }): Promise<unknown> };
    };
  }
).chrome;

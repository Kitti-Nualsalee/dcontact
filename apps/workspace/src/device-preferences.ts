/**
 * Audio devices the Agent chose from the device-test button (#939) and the latest test result
 * stored only in the browser's localStorage, never sent to the server because a device name may contain a person's name (owner decision item 8)
 * unreadable/unwritable (private mode, storage blocked) = use the system default device
 */
export interface DevicePreferences {
  micId?: string;
  speakerId?: string;
}

export type DeviceTestResult = 'pass' | 'warn';

export interface DeviceTestRecord {
  result: DeviceTestResult;
  /** ISO 8601 */
  at: string;
}

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

const DEVICES_KEY = 'dcontact.workspace.audioDevices';
const TEST_KEY = 'dcontact.workspace.deviceTest';

export interface DevicePreferenceStore {
  devices(): DevicePreferences;
  setDevices(patch: DevicePreferences): void;
  lastTest(): DeviceTestRecord | undefined;
  setLastTest(record: DeviceTestRecord): void;
  subscribe(listener: () => void): () => void;
  /** changes every time a value changes — used with useSyncExternalStore */
  version(): number;
}

export function createDevicePreferenceStore(
  storage: () => KeyValueStorage | undefined,
): DevicePreferenceStore {
  const listeners = new Set<() => void>();
  let version = 0;
  let devices = parse(read(storage, DEVICES_KEY), isDevicePreferences) ?? {};
  let lastTest = parse(read(storage, TEST_KEY), isDeviceTestRecord);
  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };
  return {
    devices: () => devices,
    setDevices(patch) {
      devices = withoutEmpty({ ...devices, ...patch });
      write(storage, DEVICES_KEY, JSON.stringify(devices));
      notify();
    },
    lastTest: () => lastTest,
    setLastTest(record) {
      lastTest = record;
      write(storage, TEST_KEY, JSON.stringify(record));
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
  };
}

/** store of the Workspace page — the call transport reads from here every time it takes a call */
export const devicePreferences = createDevicePreferenceStore(() => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
});

/**
 * mic constraint for getUserMedia — uses `ideal`, not `exact`
 * if the remembered device was unplugged the browser uses the default instead of rejecting the call
 */
export function micConstraint(preferences: DevicePreferences): MediaTrackConstraints | true {
  return preferences.micId ? { deviceId: { ideal: preferences.micId } } : true;
}

/** is the remembered device still connected — not having chosen means using the default, not missing */
export function rememberedDeviceMissing(
  id: string | undefined,
  available: readonly Pick<MediaDeviceInfo, 'deviceId'>[],
): boolean {
  return Boolean(id && id !== 'default' && !available.some((device) => device.deviceId === id));
}

type SinkElement = HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> };

export function supportsSpeakerSelection(element: HTMLMediaElement): boolean {
  return typeof (element as SinkElement).setSinkId === 'function';
}

/**
 * send an element's audio to the chosen speaker — a browser that cannot choose a speaker (some Firefox/Safari versions) uses the default
 * if the chosen speaker was unplugged, setSinkId rejects → use the default instead, so the customer's audio is not silent
 */
export async function routeToSpeaker(
  element: HTMLMediaElement,
  speakerId: string | undefined,
): Promise<'applied' | 'default' | 'unsupported'> {
  const sink = element as SinkElement;
  if (typeof sink.setSinkId !== 'function') return 'unsupported';
  try {
    await sink.setSinkId(speakerId ?? '');
    return speakerId ? 'applied' : 'default';
  } catch {
    await sink.setSinkId('').catch(() => undefined);
    return 'default';
  }
}

function read(storage: () => KeyValueStorage | undefined, key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: () => KeyValueStorage | undefined, key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // see the file header — if it cannot be remembered, keep using it in this page
  }
}

function parse<T>(raw: string | null, guard: (value: unknown) => value is T): T | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return guard(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isDevicePreferences(value: unknown): value is DevicePreferences {
  if (!value || typeof value !== 'object') return false;
  const { micId, speakerId } = value as Record<string, unknown>;
  return (
    (micId === undefined || typeof micId === 'string') &&
    (speakerId === undefined || typeof speakerId === 'string')
  );
}

function isDeviceTestRecord(value: unknown): value is DeviceTestRecord {
  if (!value || typeof value !== 'object') return false;
  const { result, at } = value as Record<string, unknown>;
  return (result === 'pass' || result === 'warn') && typeof at === 'string';
}

function withoutEmpty(preferences: DevicePreferences): DevicePreferences {
  const next: DevicePreferences = {};
  if (preferences.micId) next.micId = preferences.micId;
  if (preferences.speakerId) next.speakerId = preferences.speakerId;
  return next;
}

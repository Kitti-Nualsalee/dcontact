/**
 * อุปกรณ์เสียงที่ Agent เลือกจากปุ่มทดสอบอุปกรณ์ (#939) และผลทดสอบล่าสุด
 * เก็บใน localStorage ของ browser เท่านั้น ไม่ส่งขึ้น server เพราะชื่ออุปกรณ์อาจมีชื่อคน (คำตัดสิน owner ข้อ 8)
 * อ่าน/เขียนไม่ได้ (private mode, storage ถูกบล็อก) = ใช้อุปกรณ์เริ่มต้นของระบบ
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
  /** เปลี่ยนทุกครั้งที่ค่าเปลี่ยน — ใช้กับ useSyncExternalStore */
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

/** store ของหน้า Workspace — transport ของสายอ่านจากที่นี่ทุกครั้งที่รับสาย */
export const devicePreferences = createDevicePreferenceStore(() => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
});

/**
 * constraint ของไมค์สำหรับ getUserMedia — ใช้ `ideal` ไม่ใช่ `exact`
 * อุปกรณ์ที่จำไว้ถอดออกแล้ว browser จะใช้ค่าเริ่มต้นแทนการปฏิเสธสาย
 */
export function micConstraint(preferences: DevicePreferences): MediaTrackConstraints | true {
  return preferences.micId ? { deviceId: { ideal: preferences.micId } } : true;
}

/** อุปกรณ์ที่จำไว้ยังต่ออยู่ไหม — ไม่ได้เลือกไว้ถือว่าใช้ค่าเริ่มต้น ไม่ใช่หาย */
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
 * ส่งเสียงของ element ไปลำโพงที่เลือก — browser ที่เลือกลำโพงไม่ได้ (Firefox/Safari บางรุ่น) ใช้ค่าเริ่มต้น
 * ลำโพงที่เลือกถอดออกแล้ว setSinkId ปฏิเสธ → ใช้ค่าเริ่มต้นแทน ไม่ให้เสียงลูกค้าเงียบ
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
    // ดูหัวไฟล์ — จำไม่ได้ก็ใช้ต่อในหน้านี้
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

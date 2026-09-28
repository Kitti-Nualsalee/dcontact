/**
 * E1.15 (#489): `<dphone-launcher tenant="...">` — Web Component สำหรับ host (E1.7 #463 ข้อ 3)
 *
 * ```html
 * <script type="module" src="https://<dphone-origin>/embed/v1/dphone-launcher.js"></script>
 * <dphone-launcher tenant="acme"></dphone-launcher>
 * <script>
 *   const dphone = document.querySelector('dphone-launcher');
 *   dphone.addEventListener('screenpop', (event) => openRecord(event.detail));
 *   dphone.addEventListener('activity', (event) => event.waitUntil(saveActivity(event.detail)));
 *   await dphone.call('0812345678', { contactId: 'CIF-001' });
 * </script>
 * ```
 *
 * - dphone origin มาจาก URL ของไฟล์นี้เอง (`import.meta.url`) หรือ attribute `origin` — ไม่ใช้ `*`
 * - iframe `/dphone/embed?tenant=` พร้อม `allow="microphone; autoplay"` และ sandbox ที่มี `allow-popups`
 * - event: `ready`, `screenpop`, `activity` (ack อัตโนมัติเมื่อ `waitUntil` ทุกตัวสำเร็จ), `callresult`, `dphoneerror`
 */
import { LauncherCore, type CallOptions, type LauncherEvents } from './launcher-core.js';
import type { CallResultMessage } from './protocol.js';

export const DPHONE_LAUNCHER_TAG = 'dphone-launcher';

/** event ของ launcher — `waitUntil()` ใช้ได้กับ `activity` เพื่อเลื่อน ack จนกว่างานของ host จะเสร็จ */
export class DphoneLauncherEvent<T> extends Event {
  readonly pending: Promise<unknown>[] = [];

  constructor(
    type: string,
    readonly detail: T,
  ) {
    super(type);
  }

  waitUntil(promise: Promise<unknown>) {
    this.pending.push(promise);
  }
}

const EVENT_NAMES: Record<keyof LauncherEvents, string> = {
  ready: 'ready',
  screenpop: 'screenpop',
  activity: 'activity',
  callresult: 'callresult',
  // `error` ของ DOM มีความหมายเดิมอยู่แล้ว (โหลดล้ม) จึงแยกชื่อ
  error: 'dphoneerror',
};

function defaultOrigin(): string {
  try {
    return new URL(import.meta.url).origin;
  } catch {
    return '';
  }
}

export class DphoneLauncherElement extends HTMLElement {
  static observedAttributes = ['tenant'];

  private iframe: HTMLIFrameElement | null = null;
  private core: LauncherCore | null = null;
  private readonly onMessage = (event: MessageEvent) => this.core?.handle(event);

  get dphoneOrigin(): string {
    return this.getAttribute('origin') ?? defaultOrigin();
  }

  get capabilities() {
    return this.core?.capabilities ?? null;
  }

  connectedCallback() {
    this.render();
    window.addEventListener('message', this.onMessage);
  }

  disconnectedCallback() {
    window.removeEventListener('message', this.onMessage);
    this.iframe?.remove();
    this.iframe = null;
    this.core = null;
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  /** กรอกเบอร์ใน dphone ให้ agent กดโทรเอง — resolve ด้วยผลที่ไม่มี PII */
  call(number: string, options: CallOptions = {}): Promise<CallResultMessage> {
    if (!this.core) return Promise.reject(new Error('dphone-launcher is not connected'));
    return this.core.call(number, options);
  }

  private render() {
    const tenant = this.getAttribute('tenant');
    const origin = this.dphoneOrigin;
    this.iframe?.remove();
    this.iframe = null;
    this.core = null;
    if (!tenant || !origin) return;

    const iframe = document.createElement('iframe');
    const src = new URL('/dphone/embed', origin);
    src.searchParams.set('tenant', tenant);
    iframe.src = src.toString();
    iframe.title = this.getAttribute('label') ?? 'dphone';
    iframe.allow = 'microphone; autoplay';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms');
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = '0';
    if (!this.style.display) this.style.display = 'block';
    this.append(iframe);
    this.iframe = iframe;

    this.core = new LauncherCore({
      dphoneOrigin: origin,
      target: () => iframe.contentWindow,
      requestId: () => crypto.randomUUID(),
      emit: (type, message) => {
        const event = new DphoneLauncherEvent(EVENT_NAMES[type], message);
        this.dispatchEvent(event);
        return event.pending;
      },
    });
  }
}

if (typeof customElements !== 'undefined' && !customElements.get(DPHONE_LAUNCHER_TAG)) {
  customElements.define(DPHONE_LAUNCHER_TAG, DphoneLauncherElement);
}

declare global {
  interface HTMLElementTagNameMap {
    'dphone-launcher': DphoneLauncherElement;
  }
}

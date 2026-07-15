import { Connection, Event } from 'modesl';

export interface EslClientOptions {
  host: string;
  port: number;
  password: string;
  /** FreeSWITCH event names ที่สนใจ เช่น CHANNEL_CREATE, CHANNEL_ANSWER */
  events: string[];
  onEvent: (event: Event) => void;
  reconnectDelayMs?: number;
}

/**
 * ESL inbound connection ต่อ FreeSWITCH พร้อม auto-reconnect
 * นี่คือจุดเดียวที่ระบบคุยกับ FreeSWITCH — business logic ห้ามอยู่ในไฟล์นี้
 */
export class EslClient {
  private conn: Connection | null = null;
  private stopped = false;

  constructor(private readonly opts: EslClientOptions) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.conn?.disconnect();
    this.conn = null;
  }

  /** ส่ง api command เช่น uuid_bridge, uuid_record (Phase 1) */
  api(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.conn) return reject(new Error('ESL not connected'));
      this.conn.api(command, (res) => resolve(res.getHeader('Reply-Text') ?? res.serialize()));
    });
  }

  private connect() {
    const { host, port, password, events, onEvent } = this.opts;
    console.log(`[telephony] connecting ESL ${host}:${port} ...`);

    const conn = new Connection(host, port, password, () => {
      console.log('[telephony] ESL connected');
      conn.subscribe(events);
    });

    conn.on('esl::event::**', (event: Event) => {
      // modesl ยิง event ภายในบางตัวที่ไม่ใช่ FS event — กรองด้วย Event-Name
      if (event?.getHeader?.('Event-Name')) onEvent(event);
    });

    conn.on('error', (err: Error) => {
      console.error('[telephony] ESL error:', err.message);
    });

    conn.on('esl::end', () => {
      console.warn('[telephony] ESL disconnected');
      this.scheduleReconnect();
    });

    this.conn = conn;
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const delay = this.opts.reconnectDelayMs ?? 3000;
    setTimeout(() => this.connect(), delay);
  }
}

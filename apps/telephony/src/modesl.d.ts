// typings ขั้นต่ำสำหรับ modesl (ไม่มี official types)
declare module 'modesl' {
  import { EventEmitter } from 'events';

  export class Event {
    getHeader(name: string): string | null;
    getType(): string;
    serialize(format?: string): string;
  }

  export class Connection extends EventEmitter {
    constructor(host: string, port: number, password: string, readyCallback?: () => void);
    subscribe(events: string | string[], cb?: () => void): void;
    api(command: string, cb?: (res: Event) => void): void;
    bgapi(command: string, cb?: (res: Event) => void): void;
    execute(app: string, arg: string, uuid: string, cb?: (res: Event) => void): void;
    disconnect(): void;
    connected(): boolean;
  }
}

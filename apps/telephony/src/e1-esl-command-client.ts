import net from 'node:net';
import type { FreeSwitchEslCommandClient } from './freeswitch-command-adapter.js';

export class E1EslCommandClient implements FreeSwitchEslCommandClient {
  constructor(
    private readonly options: {
      host: string;
      port: number;
      password: string;
      timeoutMs?: number;
      onBackgroundJob?(jobUuid: string, command: string): void;
    },
  ) {}

  command(value: string): Promise<void> {
    if (/[\r\n]/.test(value)) return Promise.reject(new Error('E1_ESL_INVALID_COMMAND'));
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.options.host, port: this.options.port });
      let buffer = Buffer.alloc(0);
      let stage: 'AUTH_REQUEST' | 'AUTH_REPLY' | 'COMMAND_REPLY' = 'AUTH_REQUEST';
      const timer = setTimeout(() => finish(false), this.options.timeoutMs ?? 5000);
      const finish = (accepted: boolean) => {
        clearTimeout(timer);
        socket.destroy();
        if (accepted) resolve();
        else reject(new Error('E1_ESL_COMMAND_UNCONFIRMED'));
      };
      socket.on('error', () => finish(false));
      socket.on('close', () => finish(false));
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          const separator = buffer.indexOf('\n\n');
          const carriageSeparator = buffer.indexOf('\r\n\r\n');
          const offset = carriageSeparator >= 0 ? carriageSeparator : separator;
          if (offset < 0) return;
          const header = buffer.subarray(0, offset).toString('utf8');
          const length = Number(/^Content-Length:\s*(\d+)$/im.exec(header)?.[1] ?? 0);
          const headerLength = offset + (carriageSeparator >= 0 ? 4 : 2);
          if (buffer.length < headerLength + length) return;
          const frame = buffer.subarray(0, headerLength + length).toString('utf8');
          buffer = buffer.subarray(headerLength + length);
          if (stage === 'AUTH_REQUEST') {
            if (!/Content-Type:\s*auth\/request/i.test(header)) {
              finish(false);
              return;
            }
            stage = 'AUTH_REPLY';
            socket.write(`auth ${this.options.password}\n\n`);
          } else if (stage === 'AUTH_REPLY') {
            if (!/Reply-Text:\s*\+OK accepted/i.test(header)) {
              finish(false);
              return;
            }
            stage = 'COMMAND_REPLY';
            socket.write(`${value}\n\n`);
          } else {
            const accepted =
              /^Reply-Text:\s*\+OK/im.test(header) ||
              (/Content-Type:\s*api\/response/i.test(header) &&
                /^\+OK/m.test(frame.slice(headerLength)));
            const jobUuid = /Reply-Text:\s*\+OK Job-UUID:\s*([0-9a-f-]{36})/i.exec(header)?.[1];
            if (accepted && jobUuid) this.options.onBackgroundJob?.(jobUuid, value);
            finish(accepted);
            return;
          }
        }
      });
    });
  }
}

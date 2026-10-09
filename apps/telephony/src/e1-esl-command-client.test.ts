import assert from 'node:assert/strict';
import net, { type AddressInfo } from 'node:net';
import test from 'node:test';
import { E1EslCommandClient } from './e1-esl-command-client.js';

for (const result of ['+OK accepted', '-ERR command rejected', 'timeout']) {
  test(`ESL client ตรวจคำตอบจริง ไม่ถือว่า socket.write คือ success: ${result}`, async (context) => {
    const server = net.createServer((socket) => {
      socket.write('Content-Type: auth/request\n\n');
      let buffer = '';
      let authenticated = false;
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        if (!buffer.endsWith('\n\n')) return;
        if (!authenticated) {
          assert.equal(buffer, 'auth test-only\n\n');
          authenticated = true;
          socket.write('Content-Type: command/reply\nReply-Text: +OK accepted\n\n');
        } else {
          assert.equal(buffer, 'api uuid_kill test\n\n');
          if (result !== 'timeout')
            socket.write(
              `Content-Type: api/response\nContent-Length: ${Buffer.byteLength(result)}\n\n${result}`,
            );
        }
        buffer = '';
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const client = new E1EslCommandClient({
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      password: 'test-only',
      timeoutMs: 200,
    });
    if (result.startsWith('+OK')) await client.command('api uuid_kill test');
    else await assert.rejects(client.command('api uuid_kill test'), /E1_ESL_COMMAND_UNCONFIRMED/);
    await assert.rejects(client.command('api status\napi shutdown'), /E1_ESL_INVALID_COMMAND/);
  });
}

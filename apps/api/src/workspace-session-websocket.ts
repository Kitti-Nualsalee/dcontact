import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type {
  WorkspaceSessionSocket,
  WorkspaceSessionSocketMessage,
  WorkspaceSessionWebSocketAdapter,
} from '@d-contact/workspace-session';
import { WebSocketServer } from 'ws';

export function attachWorkspaceSessionWebSocket(
  server: Server,
  adapter: Pick<WorkspaceSessionWebSocketAdapter, 'handle' | 'disconnect'>,
): WebSocketServer {
  const sockets = new WebSocketServer({ noServer: true });

  sockets.on('connection', (socket, request) => {
    const suppliedCorrelationId = request.headers['x-correlation-id'];
    const correlationId =
      typeof suppliedCorrelationId === 'string' &&
      /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedCorrelationId)
        ? suppliedCorrelationId
        : randomUUID();
    socket.once('close', () => adapter.disconnect(socket as WorkspaceSessionSocket));
    socket.on('message', (data) => {
      let message: WorkspaceSessionSocketMessage;
      try {
        message = JSON.parse(data.toString()) as WorkspaceSessionSocketMessage;
      } catch {
        socket.close(4400, 'invalid workspace message');
        return;
      }
      void adapter.handle(socket as WorkspaceSessionSocket, message, correlationId);
    });
  });

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/api/v1/workspace-session') {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (webSocket) =>
      sockets.emit('connection', webSocket, request),
    );
  });

  return sockets;
}

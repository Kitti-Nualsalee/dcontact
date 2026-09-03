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

  sockets.on('connection', (socket) => {
    socket.once('close', () => adapter.disconnect(socket as WorkspaceSessionSocket));
    socket.on('message', (data) => {
      let message: WorkspaceSessionSocketMessage;
      try {
        message = JSON.parse(data.toString()) as WorkspaceSessionSocketMessage;
      } catch {
        socket.close(4400, 'invalid workspace message');
        return;
      }
      void adapter.handle(socket as WorkspaceSessionSocket, message);
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

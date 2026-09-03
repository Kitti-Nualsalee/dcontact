import type { IncomingMessage, ServerResponse } from 'node:http';
import { withTenantContext } from '@d-contact/db';
import type { WorkspaceSessionHttpAdapter } from '@d-contact/workspace-session';

export function createWorkspaceSessionHandler(adapter: WorkspaceSessionHttpAdapter) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const result = await adapter.connect({
      authorization: request.headers.authorization,
      tabId: request.headers['x-workspace-tab-id'] as string | undefined,
    });
    if (result.status === 200) {
      await withTenantContext(result.body.tenantId, () => {
        response.writeHead(result.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result.body));
      });
      return;
    }
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body));
  };
}

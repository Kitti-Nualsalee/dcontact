import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkspaceSessionHttpAdapter } from '@d-contact/workspace-session';

export type TenantScope = <T>(tenantId: string, work: () => Promise<T> | T) => Promise<T>;

export function createWorkspaceSessionHandler(
  adapter: WorkspaceSessionHttpAdapter,
  withTenant: TenantScope,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const result = await adapter.connect({
      authorization: request.headers.authorization,
      tabId: request.headers['x-workspace-tab-id'] as string | undefined,
    });
    if (result.status === 200) {
      await withTenant(result.body.tenantId, () => {
        response.writeHead(result.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result.body));
      });
      return;
    }
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body));
  };
}

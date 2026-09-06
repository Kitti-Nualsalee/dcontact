import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createAgentWorkspaceApi, type AgentWorkspaceApi } from './agent-api.js';
import { WorkspaceAuthRoot } from './auth-root.js';
import { WorkspaceApp, createDeterministicSoftphone } from './workspace-app.js';
import { createSupervisorWorkspaceApi } from './supervisor-api.js';
import { SupervisorWorkspace } from './supervisor-workspace.js';
import './workspace-app.css';

const root = document.getElementById('root');

if (!root) throw new Error('Workspace root element is required');

const e2eHttpApi = createAgentWorkspaceApi({
  baseUrl: window.location.origin,
  accessToken: () => 'e2e-access-token',
});
const e2eApi: AgentWorkspaceApi = {
  snapshot: () => e2eHttpApi.snapshot(),
  sipCredentials: async () => ({
    leaseId: 'e2e-lease',
    extension: '1000',
    authorizationUsername: '1000',
    authorizationPassword: 'e2e-only',
    sipDomain: 'e2e.invalid',
    wssUrl: 'wss://e2e.invalid',
    telephonyNodeId: 'fs-e2e',
    iceServers: [],
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  }),
};
const e2eSupervisorApi = createSupervisorWorkspaceApi({
  baseUrl: window.location.origin,
  accessToken: () => 'e2e-access-token',
});
const e2eView = new URL(window.location.href).searchParams.get('view');

const application =
  import.meta.env.MODE === 'e2e' ? (
    e2eView === 'supervisor' ? (
      <SupervisorWorkspace api={e2eSupervisorApi} tenantLabel="demo" />
    ) : (
      <WorkspaceApp
        api={e2eApi}
        tenantLabel="demo"
        createSoftphone={(_remoteAudio, callbacks) => createDeterministicSoftphone(callbacks)}
      />
    )
  ) : (
    <WorkspaceAuthRoot />
  );

createRoot(root).render(<StrictMode>{application}</StrictMode>);

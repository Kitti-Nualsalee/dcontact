import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createAgentWorkspaceApi, type AgentWorkspaceApi } from './agent-api.js';
import { WorkspaceAuthRoot } from './auth-root.js';
import { WorkspaceApp, createDeterministicDphone } from './workspace-app.js';
import { createSupervisorWorkspaceApi } from './supervisor-api.js';
import { SupervisorWorkspace } from './supervisor-workspace.js';
import { SessionLocaleProvider } from '@d-contact/i18n/react';
import { appI18n } from './i18n/index.js';
import { WorkspaceShell } from './shell/workspace-shell.js';
import { DphonePage } from './dphone/dphone-page.js';
import './workspace-app.css';

const root = document.getElementById('root');

if (!root) throw new Error('Workspace root element is required');

const e2eHttpApi = createAgentWorkspaceApi({
  baseUrl: window.location.origin,
  accessToken: () => 'e2e-access-token',
});
const e2eApi: AgentWorkspaceApi = {
  snapshot: () => e2eHttpApi.snapshot(),
  submitWrapup: (input) => e2eHttpApi.submitWrapup(input),
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

const e2eShellProps = {
  apiBaseUrl: window.location.origin,
  accessToken: () => 'e2e-access-token',
  tenantAlias: new URL(window.location.href).searchParams.get('tenant') ?? undefined,
} as const;

// D1.15 (#454): `/dphone` คือหน้าต่าง dphone ที่แยกออกจาก Workspace — ไม่มี session/token ของตัวเอง
// คุยกับ working tab ผ่าน BroadcastChannel จึงไม่ต้องผ่าน AuthProvider
const application =
  window.location.pathname === '/dphone' ? (
    <SessionLocaleProvider i18n={appI18n}>
      <DphonePage />
    </SessionLocaleProvider>
  ) : import.meta.env.MODE === 'e2e' ? (
    <SessionLocaleProvider i18n={appI18n}>
      {e2eView === 'supervisor' ? (
        <WorkspaceShell {...e2eShellProps} appId="supervisor-workspace">
          <SupervisorWorkspace api={e2eSupervisorApi} tenantLabel="demo" />
        </WorkspaceShell>
      ) : (
        <WorkspaceShell {...e2eShellProps} appId="agent-workspace">
          <WorkspaceApp
            api={e2eApi}
            tenantLabel="demo"
            createDphone={(_remoteAudio, callbacks) => createDeterministicDphone(callbacks)}
          />
        </WorkspaceShell>
      )}
    </SessionLocaleProvider>
  ) : (
    <WorkspaceAuthRoot />
  );

createRoot(root).render(<StrictMode>{application}</StrictMode>);

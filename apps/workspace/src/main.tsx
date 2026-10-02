import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createAgentWorkspaceApi, type AgentWorkspaceApi } from './agent-api.js';
import { WorkspaceAuthRoot } from './auth-root.js';
import { WorkspaceApp, createDeterministicDphone, type DphoneFactory } from './workspace-app.js';
import { createSupervisorWorkspaceApi } from './supervisor-api.js';
import { SupervisorWorkspace } from './supervisor-workspace.js';
import { SessionLocaleProvider } from '@d-contact/i18n/react';
import { shellUserFromClaims } from '@d-contact/ui-react';
import { appI18n } from './i18n/index.js';
import { WorkspaceShell } from './shell/workspace-shell.js';
import { DphonePage } from './dphone/dphone-page.js';
import { createWorkSessionApi } from './work-session.js';
import './workspace-app.css';

const root = document.getElementById('root');

if (!root) throw new Error('Workspace root element is required');

const e2eHttpApi = createAgentWorkspaceApi({
  baseUrl: window.location.origin,
  accessToken: () => 'e2e-access-token',
});
const e2eSearch = new URL(window.location.href).searchParams;
const e2eApi: AgentWorkspaceApi = {
  // E1.12: WS ของ routing เฉพาะ spec ที่ mock WS เอง (`?live=1`) — spec อื่นไม่มี WS เหมือนเดิม
  ...(e2eSearch.get('live') === '1'
    ? { subscribeLive: (handlers, options) => e2eHttpApi.subscribeLive!(handlers, options) }
    : {}),
  snapshot: () => e2eHttpApi.snapshot(),
  submitWrapup: (input) => e2eHttpApi.submitWrapup(input),
  sipCredentials: async (workSessionLeaseId) => ({
    leaseId: workSessionLeaseId,
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
const e2eView = e2eSearch.get('view');
// E1.12: work-session lease ผ่าน API จริงของ origin — spec ที่ไม่ mock ได้ 404 = flag ปิด (พฤติกรรมเดิม)
const e2eWorkSession = createWorkSessionApi({
  baseUrl: window.location.origin,
  accessToken: () => 'e2e-access-token',
});

const e2eShellProps = {
  apiBaseUrl: window.location.origin,
  accessToken: () => 'e2e-access-token',
  tenantAlias: new URL(window.location.href).searchParams.get('tenant') ?? undefined,
  // #588: ผู้ใช้จำลองของเมนูผู้ใช้ — การออกจากระบบนับใน `window.__signOuts` ให้ spec ตรวจ
  user: shellUserFromClaims(
    {
      name: 'ผู้ทดสอบ เวิร์กสเปซ',
      email: 'workspace-e2e@demo.example',
      realm_access: { roles: ['agent'] },
    },
    new URL(window.location.href).searchParams.get('tenant') ?? undefined,
  ),
  onSignOut: () => {
    const w = window as unknown as { __signOuts?: number };
    w.__signOuts = (w.__signOuts ?? 0) + 1;
  },
} as const;

// ต้องเป็นค่าคงที่ — WorkspaceApp สร้าง dphone ใหม่เมื่อ factory เปลี่ยน (re-render ต้องไม่ตัดสาย)
const e2eCreateDphone: DphoneFactory = (_remoteAudio, callbacks) =>
  createDeterministicDphone(callbacks);

/** #588: สถานะมีสายส่งจาก WorkspaceApp ขึ้นไปที่ shell แบบเดียวกับ auth-root */
function E2eAgentWorkspace() {
  const [callActive, setCallActive] = useState(false);
  return (
    <WorkspaceShell {...e2eShellProps} appId="agent-workspace" callActive={callActive}>
      <WorkspaceApp
        api={e2eApi}
        tenantLabel="demo"
        createDphone={e2eCreateDphone}
        workSession={e2eWorkSession}
        onSignOut={e2eShellProps.onSignOut}
        onActiveCallChange={setCallActive}
      />
    </WorkspaceShell>
  );
}

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
        <E2eAgentWorkspace />
      )}
    </SessionLocaleProvider>
  ) : (
    <WorkspaceAuthRoot />
  );

createRoot(root).render(<StrictMode>{application}</StrictMode>);

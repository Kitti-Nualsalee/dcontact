import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConsoleAuthRoot } from './auth-root.js';
import { ConsoleApp } from './console-app.js';
import { createConsoleApi } from './console-api.js';
import { GovernanceConsole } from './governance-console.js';
import { createGovernanceApi } from './governance-api.js';
import { createCg5ConsoleApi } from './cg5-console-api.js';
import { parseGovernanceLocation, type GovernanceViewer } from './governance-model.js';
import { PreferenceCenter } from './preference-center.js';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('root element is required');
createRoot(root).render(
  <StrictMode>
    {import.meta.env.MODE === 'e2e' ? <ConsoleE2eRoot /> : <ConsoleAuthRoot />}
  </StrictMode>,
);

function ConsoleE2eRoot() {
  const url = new URL(window.location.href);
  const contextId = url.searchParams.get('context');
  const contactId = url.searchParams.get('contactId');
  const api = createConsoleApi({
    baseUrl: (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin,
    accessToken: () => 'e2e-access-token',
  });
  if (url.searchParams.get('view') === 'governance') {
    // viewer จาก query ใช้ได้เฉพาะ e2e harness; production อ่าน role จาก token เท่านั้น
    const requested = url.searchParams.get('viewer');
    const viewer: GovernanceViewer =
      requested === 'SUPERVISOR' || requested === 'TENANT_ADMIN' ? requested : 'COMPLIANCE';
    return (
      <GovernanceConsole
        api={createGovernanceApi({
          baseUrl:
            (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin,
          accessToken: () => 'e2e-access-token',
        })}
        cg5Api={createCg5ConsoleApi({
          baseUrl:
            (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin,
          accessToken: () => 'e2e-access-token',
        })}
        viewer={viewer}
        initialLocation={parseGovernanceLocation(url)}
      />
    );
  }
  return url.searchParams.get('view') === 'preferences' && contactId ? (
    <PreferenceCenter api={api} contactId={contactId} viewer="ADMIN" />
  ) : contextId ? (
    <ConsoleApp api={api} contextId={contextId} />
  ) : (
    <main className="empty">missing context</main>
  );
}

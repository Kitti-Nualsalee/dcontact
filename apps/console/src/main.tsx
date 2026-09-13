import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConsoleAuthRoot } from './auth-root.js';
import { ConsoleApp } from './console-app.js';
import { Cg4GovernancePrototype } from './cg4-governance-prototype.js';
import { createConsoleApi } from './console-api.js';
import { PreferenceCenter } from './preference-center.js';
import './style.css';
import './cg4-governance-prototype.css';

const root = document.getElementById('root');
if (!root) throw new Error('root element is required');
const initialUrl = new URL(window.location.href);
const showCg4Prototype =
  !import.meta.env.PROD && initialUrl.searchParams.get('view') === 'cg4-prototype';
createRoot(root).render(
  <StrictMode>
    {showCg4Prototype ? (
      <Cg4GovernancePrototype />
    ) : import.meta.env.MODE === 'e2e' ? (
      <ConsoleE2eRoot />
    ) : (
      <ConsoleAuthRoot />
    )}
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
  return url.searchParams.get('view') === 'preferences' && contactId ? (
    <PreferenceCenter api={api} contactId={contactId} viewer="ADMIN" />
  ) : contextId ? (
    <ConsoleApp api={api} contextId={contextId} />
  ) : (
    <main className="empty">missing context</main>
  );
}

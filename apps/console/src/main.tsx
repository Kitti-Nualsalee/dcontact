import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConsoleApp } from './console-app.js';
import { createConsoleApi } from './console-api.js';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('root element is required');
const interactionId = new URL(window.location.href).searchParams.get('interaction');
const api = createConsoleApi({
  baseUrl: (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin,
  accessToken: () => (import.meta.env.MODE === 'e2e' ? 'e2e-access-token' : undefined),
});
createRoot(root).render(
  <StrictMode>
    {interactionId ? (
      <ConsoleApp api={api} interactionId={interactionId} />
    ) : (
      <main className="empty">
        <h1>ไม่พบ Interaction context</h1>
        <p>เปิด Console จาก Workspace ด้วย opaque Interaction context</p>
      </main>
    )}
  </StrictMode>,
);

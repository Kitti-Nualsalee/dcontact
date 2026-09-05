import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createAgentWorkspaceApi } from './agent-api.js';
import { WorkspaceAuthRoot } from './auth-root.js';
import { WorkspaceApp } from './workspace-app.js';
import './workspace-app.css';

const root = document.getElementById('root');

if (!root) throw new Error('Workspace root element is required');

const application =
  import.meta.env.MODE === 'e2e' ? (
    <WorkspaceApp
      api={createAgentWorkspaceApi({
        baseUrl: window.location.origin,
        accessToken: () => 'e2e-access-token',
      })}
      tenantLabel="demo"
    />
  ) : (
    <WorkspaceAuthRoot />
  );

createRoot(root).render(<StrictMode>{application}</StrictMode>);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceApp } from './workspace-app.js';
import './workspace-app.css';

const root = document.getElementById('root');

if (!root) throw new Error('Workspace root element is required');

createRoot(root).render(
  <StrictMode>
    <WorkspaceApp />
  </StrictMode>,
);

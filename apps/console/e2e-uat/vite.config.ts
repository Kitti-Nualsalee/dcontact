import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * U1.7 (#435): Console of the acceptance gate — same-origin like UAT (Caddy sends `/api/v1/*` to the API)
 * the Vite dev server forwards `/api/v1` to the real API with profile `uat`; no mocks at all
 */
const apiUrl = process.env.U1_API_URL;
if (!apiUrl) throw new Error('U1_API_URL is required (run through `pnpm cxa:u1:acceptance`)');

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: {
    strictPort: true,
    proxy: { '/api/v1': { target: apiUrl, changeOrigin: false } },
  },
});

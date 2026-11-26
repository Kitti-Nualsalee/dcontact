/**
 * Vite config of the Console for the Demo stack only (`scripts/sales-demo-stack.mjs`)
 * the dev API allows a single CORS origin (the Workspace), so have the Console call `/api` through its own origin
 * like being behind a reverse proxy on UAT, without changing the CORS of the API
 */
export default {
  server: { proxy: { '/api': 'http://localhost:3000' } },
};

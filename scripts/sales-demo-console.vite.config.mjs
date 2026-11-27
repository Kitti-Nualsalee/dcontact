/**
 * Vite config of the Console for the Demo stack only (`scripts/sales-demo-stack.mjs`)
 * the dev API allows a single CORS origin (the Workspace), so have the Console call `/api` through its own origin
 * like being behind a reverse proxy on UAT, without changing the CORS of the API
 */
export default {
  server: {
    proxy: { '/api': 'http://localhost:3000' },
    // Vite would otherwise add `Access-Control-Allow-Origin` (reflecting any origin) to proxied API answers,
    // which production (Caddy) does not do; the web chat widget's origin check must behave as in production
    cors: false,
  },
};

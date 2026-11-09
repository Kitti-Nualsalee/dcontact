import { defineConfig, loadEnv } from 'vite';

function workspaceUrl(value: string): URL {
  const url = new URL(value);
  const isLocalHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (
    (!isLocalHttp && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('D_PHONE_WORKSPACE_ORIGIN must be an HTTPS origin or an HTTP loopback origin');
  }
  return url;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'D_PHONE_');
  const url = workspaceUrl(env.D_PHONE_WORKSPACE_ORIGIN ?? 'http://localhost:5173');
  return {
    base: './',
    define: { __D_PHONE_WORKSPACE_ORIGIN__: JSON.stringify(url.origin) },
    plugins: [
      {
        name: 'd-phone-manifest',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'manifest.json',
            source: JSON.stringify(
              {
                manifest_version: 3,
                minimum_chrome_version: '116',
                name: 'D-Phone',
                version: '0.1.0',
                description: 'D-Contact Workspace softphone',
                icons: { 32: 'favicon-32.png', 64: 'd-contact-icon-64.png' },
                action: {
                  default_title: 'D-Phone',
                  default_icon: { 32: 'favicon-32.png' },
                },
                background: { service_worker: 'worker.js', type: 'module' },
                // Match patterns do not fence ports. The receiving document checks the full origin.
                externally_connectable: { matches: [`${url.protocol}//${url.hostname}/*`] },
                content_security_policy: {
                  extension_pages:
                    "script-src 'self'; object-src 'self'; connect-src wss: ws://localhost:* ws://127.0.0.1:*; frame-ancestors 'none'",
                },
              },
              null,
              2,
            ),
          });
        },
      },
    ],
    build: {
      outDir: 'dist-dphone-extension',
      rollupOptions: {
        input: { phone: 'extension.html', worker: 'src/dphone-extension/worker.ts' },
        output: {
          entryFileNames: (chunk) =>
            chunk.name === 'worker' ? 'worker.js' : 'assets/[name]-[hash].js',
        },
      },
    },
  };
});

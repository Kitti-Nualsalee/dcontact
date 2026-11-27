/**
 * #1044: builds the web chat widget into `dist/`, which the API serves under `/api/v1/webchat/`:
 * `widget.js` (loader on the host page), `frame.js` + `frame.css` (the chat in an iframe) and `demo.js`.
 * Each script is a single classic file with no imports, so the pages need no module loading and a
 * strict CSP (`script-src 'self'`) is enough. The design tokens are prepended to the stylesheet so the
 * widget follows `@d-contact/ui` without a second copy of the values.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const require = createRequire(import.meta.url);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const [entry, fileName] of [
  ['src/loader.ts', 'widget.js'],
  ['src/frame.ts', 'frame.js'],
  ['src/demo.ts', 'demo.js'],
]) {
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    // the published build of @d-contact/ui is CommonJS; bundle the token values from their source instead
    resolve: {
      alias: {
        '@d-contact/ui': join(
          dirname(require.resolve('@d-contact/ui/tokens.css')),
          'tokens.generated.ts',
        ),
      },
    },
    build: {
      outDir: dist,
      emptyOutDir: false,
      target: 'es2019',
      minify: true,
      lib: {
        entry: join(root, entry),
        formats: ['iife'],
        name: 'DContactWebchat',
        fileName: () => fileName,
      },
    },
  });
}

const tokens = await readFile(require.resolve('@d-contact/ui/tokens.css'), 'utf8');
const styles = await readFile(join(root, 'src/frame.css'), 'utf8');
await writeFile(join(dist, 'frame.css'), `${tokens}\n${styles}`);

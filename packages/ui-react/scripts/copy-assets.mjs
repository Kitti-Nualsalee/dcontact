/**
 * tsc does not copy CSS — copies `*.module.css` next to the JS in dist so the app's Vite can process CSS Modules itself
 * (ADR-028: the package ships JS + d.ts + CSS Modules and does not pre-bundle CSS)
 */
import { cpSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'src');
let copied = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.css')) {
      cpSync(path, join(root, 'dist', relative(src, path)));
      copied += 1;
    }
  }
}
walk(src);
console.log(`copied ${copied} CSS file(s) to dist`);

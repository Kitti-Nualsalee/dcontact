import { defineConfig } from 'vite';

// component preview page (D1.3: a plain Vite page, no Storybook) — built to confirm it can be bundled
export default defineConfig({
  root: '.',
  build: { outDir: 'dist-preview', emptyOutDir: true },
  server: { port: 5190, strictPort: true },
  preview: { port: 5190, strictPort: true },
});

/**
 * E1.15 (#489): bundle of `<dphone-launcher>` as a single ES module file for the host (E1.7 #463 item 1)
 * `import.meta.url` is kept — the launcher uses it to find the dphone origin from the URL of its own file
 */
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist-launcher',
    emptyOutDir: true,
    target: 'es2022',
    lib: {
      entry: 'src/launcher.ts',
      formats: ['es'],
      fileName: () => 'dphone-launcher.js',
    },
  },
});

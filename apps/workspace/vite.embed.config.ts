/**
 * E1.11 (#485) / E1.14 (#488): build of the embedded dphone, separate from the Workspace page
 *
 * - emits a fixed-name file `embed/dphone-embed.js` so the API can set `DPHONE_EMBED_SCRIPT_URL` — hosting must answer
 *   CORS for the API's origin because it loads as a module script
 * - this entry is not an HTML page so Vite does not inject CSS — all CSS (including the D1.15/ui-react components)
 *   is bundled into the single file `embed/dphone-embed.css`, and the API's `/dphone/embed` shell puts a <link> next to the script
 * - built after the Workspace build into the same `dist` (does not clear the existing output)
 */
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    emptyOutDir: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: { embed: 'src/embed/main.ts' },
      output: {
        entryFileNames: 'embed/dphone-embed.js',
        chunkFileNames: 'embed/[name]-[hash].js',
        assetFileNames: (asset) =>
          [asset.name, ...(asset.names ?? [])].some((name) => name?.endsWith('.css'))
            ? 'embed/dphone-embed.css'
            : 'embed/[name]-[hash][extname]',
      },
    },
  },
});

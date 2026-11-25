/**
 * E1.11 (#485): Workspace allows no one to embed it (`frame-ancestors 'none'` including `/dphone`) — production hosting
 * must send this same header on every Workspace page; embedding goes only through the API's `/dphone/embed`
 *
 * the embedded dphone has its own build in `vite.embed.config.ts`
 */
import { defineConfig } from 'vite';

const headers = { 'Content-Security-Policy': "frame-ancestors 'none'" };

export default defineConfig({
  server: { headers },
  preview: { headers },
  // E1.14: the `embed` entry is built separately by `vite.embed.config.ts` (CSS bundled into one file for the shell to put in a <link>)
});

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * U1.7 (#435): Console ของ acceptance gate — same-origin เหมือน UAT (Caddy ส่ง `/api/v1/*` ไป API)
 * Vite dev server ส่ง `/api/v1` ต่อไปที่ API profile `uat` จริง; ไม่มี mock ใด ๆ
 */
const apiUrl = process.env.U1_API_URL;
if (!apiUrl) throw new Error('U1_API_URL is required (รันผ่าน `pnpm cxa:u1:acceptance`)');

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: {
    strictPort: true,
    proxy: { '/api/v1': { target: apiUrl, changeOrigin: false } },
  },
});

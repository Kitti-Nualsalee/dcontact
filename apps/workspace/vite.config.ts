/**
 * E1.11 (#485): Workspace ไม่ให้ใครฝัง (`frame-ancestors 'none'` รวม `/dphone`) — hosting ของ production
 * ต้องส่ง header เดียวกันนี้กับทุกหน้าของ Workspace; การฝังทำผ่าน `/dphone/embed` ของ API เท่านั้น
 *
 * entry `embed` (dphone ที่ถูกฝัง) ออกเป็นไฟล์ชื่อคงที่ `embed/dphone-embed.js` ให้ API ตั้ง
 * `DPHONE_EMBED_SCRIPT_URL` ได้ — hosting ต้องตอบ CORS ให้ origin ของ API เพราะโหลดเป็น module script
 */
import { defineConfig } from 'vite';

const headers = { 'Content-Security-Policy': "frame-ancestors 'none'" };

export default defineConfig({
  server: { headers },
  preview: { headers },
  build: {
    rollupOptions: {
      input: { main: 'index.html', embed: 'src/embed/main.ts' },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'embed' ? 'embed/dphone-embed.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});

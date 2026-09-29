/**
 * E1.11 (#485) / E1.14 (#488): build ของ dphone ที่ถูกฝัง แยกจากหน้า Workspace
 *
 * - ออกเป็นไฟล์ชื่อคงที่ `embed/dphone-embed.js` ให้ API ตั้ง `DPHONE_EMBED_SCRIPT_URL` ได้ — hosting ต้องตอบ
 *   CORS ให้ origin ของ API เพราะโหลดเป็น module script
 * - entry นี้ไม่ใช่หน้า HTML Vite จึงไม่ inject CSS ให้ — รวม CSS ทั้งหมด (รวม component ของ D1.15/ui-react)
 *   เป็น `embed/dphone-embed.css` ไฟล์เดียว แล้ว shell `/dphone/embed` ของ API ใส่ <link> ข้าง script
 * - build หลังจาก build ของ Workspace ลง `dist` เดียวกัน (ไม่ล้างของเดิม)
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

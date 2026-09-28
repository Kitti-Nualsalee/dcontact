/**
 * E1.11 (#485): Workspace ไม่ให้ใครฝัง (`frame-ancestors 'none'` รวม `/dphone`) — hosting ของ production
 * ต้องส่ง header เดียวกันนี้กับทุกหน้าของ Workspace; การฝังทำผ่าน `/dphone/embed` ของ API เท่านั้น
 *
 * dphone ที่ถูกฝังมี build ของตัวเองใน `vite.embed.config.ts`
 */
import { defineConfig } from 'vite';

const headers = { 'Content-Security-Policy': "frame-ancestors 'none'" };

export default defineConfig({
  server: { headers },
  preview: { headers },
  // E1.14: entry `embed` build แยกด้วย `vite.embed.config.ts` (CSS รวมไฟล์เดียวให้ shell ใส่ <link>)
});

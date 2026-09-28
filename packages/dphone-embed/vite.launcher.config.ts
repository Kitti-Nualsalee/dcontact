/**
 * E1.15 (#489): bundle ของ `<dphone-launcher>` เป็น ES module ไฟล์เดียวสำหรับ host (E1.7 #463 ข้อ 1)
 * `import.meta.url` ถูกคงไว้ — launcher ใช้หา dphone origin จาก URL ของไฟล์ตัวเอง
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

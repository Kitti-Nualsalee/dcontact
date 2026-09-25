import { defineConfig } from 'vite';

// preview page ของ component (D1.3: หน้า Vite ธรรมดา ไม่ใช้ Storybook) — build เพื่อยืนยันว่า bundle ได้
export default defineConfig({
  root: '.',
  build: { outDir: 'dist-preview', emptyOutDir: true },
  server: { port: 5190, strictPort: true },
  preview: { port: 5190, strictPort: true },
});

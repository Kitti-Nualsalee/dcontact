/**
 * Vite config ของ Console เฉพาะ stack Demo (`scripts/sales-demo-stack.mjs`)
 * API dev อนุญาต CORS origin เดียว (Workspace) จึงให้ Console เรียก `/api` ผ่าน origin ของตัวเอง
 * เหมือนการวางหลัง reverse proxy บน UAT โดยไม่แก้ CORS ของ API
 */
export default {
  server: { proxy: { '/api': 'http://localhost:3000' } },
};

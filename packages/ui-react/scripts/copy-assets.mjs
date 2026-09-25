/**
 * tsc ไม่คัดลอก CSS — คัดลอก `*.module.css` ไปข้าง JS ใน dist ให้ Vite ของแอปที่ใช้ประมวลผล CSS Modules เอง
 * (ADR-028: package ส่ง JS + d.ts + CSS Modules ไม่ bundle CSS ล่วงหน้า)
 */
import { cpSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'src');
let copied = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.css')) {
      cpSync(path, join(root, 'dist', relative(src, path)));
      copied += 1;
    }
  }
}
walk(src);
console.log(`คัดลอก CSS ${copied} ไฟล์ลง dist`);

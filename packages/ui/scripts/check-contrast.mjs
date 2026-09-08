#!/usr/bin/env node
/**
 * ตรวจคอนทราสต์ของคู่สีที่ token ประกาศไว้ ตามเกณฑ์ WCAG 2.1 AA
 *
 * เหตุที่ต้องมี: การตรวจ mockup รอบก่อนพบว่า 55 จาก 559 element บนหน้าเดียว
 * ตกเกณฑ์ โดยตัวหลักคือสีเทาอ่อนที่ถูกใช้กับเวลาและข้อความรอง 310 จุด
 * ถ้าไม่มีตัวตรวจอัตโนมัติ ค่าพวกนี้จะไหลกลับเข้ามาอีกโดยไม่มีใครเห็น
 *
 *   node scripts/check-contrast.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'src', 'tokens.css'), 'utf8');

const tokens = new Map();
for (const [, name, value] of css.matchAll(/(--dc-[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
  tokens.set(name, value);
}

const channel = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
function luminance(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** AA: ข้อความปกติ 4.5 · ข้อความใหญ่ (>=18.66px bold หรือ >=24px) 3.0 · องค์ประกอบที่ไม่ใช่ข้อความ 3.0 */
const TEXT = 4.5;
const LARGE = 3;
const NON_TEXT = 3;

const pairs = [
  // ข้อความหลักบนพื้นผิวแต่ละชั้น
  ['--dc-text-primary', '--dc-surface-raised', TEXT, 'ข้อความหลักบนการ์ด'],
  ['--dc-text-primary', '--dc-surface-page', TEXT, 'ข้อความหลักบนพื้นหน้า'],
  ['--dc-text-secondary', '--dc-surface-raised', TEXT, 'ข้อความรองบนการ์ด'],
  ['--dc-text-muted', '--dc-surface-raised', TEXT, 'ข้อความจางที่สุดที่ยังใช้ได้'],
  ['--dc-text-muted', '--dc-surface-page', TEXT, 'ข้อความจางบนพื้นหน้า'],
  ['--dc-text-secondary', '--dc-surface-sunken', TEXT, 'ข้อความบนพื้นร่อง (muted ห้ามใช้ที่นี่)'],
  ['--dc-text-brand', '--dc-surface-raised', TEXT, 'ลิงก์และหัวข้อโทนแบรนด์'],
  ['--dc-text-brand', '--dc-surface-selected', TEXT, 'ข้อความบนแถวที่เลือก'],
  ['--dc-text-brand-strong', '--dc-surface-raised', TEXT, 'ชื่อแบรนด์'],
  ['--dc-text-on-brand', '--dc-surface-brand', TEXT, 'ตัวอักษรบน rail'],
  ['--dc-text-on-inverse', '--dc-surface-inverse', TEXT, 'ตัวอักษรบน wallboard'],
  ['--dc-text-on-inverse-muted', '--dc-surface-inverse', TEXT, 'label บน wallboard'],

  // ป้ายสถานะ — ตัวอักษรบนพื้นอ่อนของตัวเอง
  ['--dc-success-fg', '--dc-success-bg', TEXT, 'ป้ายสำเร็จ'],
  ['--dc-attention-fg', '--dc-attention-bg', TEXT, 'ป้ายเตือน'],
  ['--dc-attention-fg-strong', '--dc-attention-bg-subtle', TEXT, 'แถบเตือนอ่อน'],
  ['--dc-critical-fg', '--dc-critical-bg', TEXT, 'ป้ายวิกฤต'],
  ['--dc-critical-fg-strong', '--dc-critical-bg-subtle', TEXT, 'แถบวิกฤตอ่อน'],
  ['--dc-info-fg', '--dc-info-bg', TEXT, 'ป้ายข้อมูล'],
  ['--dc-info-fg', '--dc-info-bg-subtle', TEXT, 'แถบข้อมูลอ่อน'],
  ['--dc-neutral-fg', '--dc-neutral-bg', TEXT, 'ป้ายกลาง'],
  ['--dc-accent-fg', '--dc-accent-bg', TEXT, 'ป้ายหมวดหมู่และ AI'],

  // สถานะเอเจนต์ — อ่านตลอดกะ ห้ามจาง
  ['--dc-agent-available-fg', '--dc-agent-available-bg', TEXT, 'สถานะพร้อมรับสาย'],
  ['--dc-agent-busy-fg', '--dc-agent-busy-bg', TEXT, 'สถานะกำลังคุย'],
  ['--dc-agent-acw-fg', '--dc-agent-acw-bg', TEXT, 'สถานะสรุปงาน'],
  ['--dc-agent-break-fg', '--dc-agent-break-bg', TEXT, 'สถานะพัก'],
  ['--dc-agent-offline-fg', '--dc-agent-offline-bg', TEXT, 'สถานะออฟไลน์'],
  ['--dc-agent-cooldown-fg', '--dc-agent-cooldown-bg', TEXT, 'สถานะ cooldown'],

  // ป้ายช่องทาง
  ['--dc-channel-voice-fg', '--dc-channel-voice-bg', TEXT, 'ป้ายช่องทาง voice'],
  ['--dc-channel-webchat-fg', '--dc-channel-webchat-bg', TEXT, 'ป้ายช่องทาง webchat'],
  ['--dc-channel-line-fg', '--dc-channel-line-bg', TEXT, 'ป้ายช่องทาง LINE'],
  ['--dc-channel-facebook-fg', '--dc-channel-facebook-bg', TEXT, 'ป้ายช่องทาง Facebook'],
  ['--dc-channel-whatsapp-fg', '--dc-channel-whatsapp-bg', TEXT, 'ป้ายช่องทาง WhatsApp'],
  ['--dc-channel-email-fg', '--dc-channel-email-bg', TEXT, 'ป้ายช่องทางอีเมล'],

  // กะและคู่สนทนา
  ['--dc-shift-day-fg', '--dc-shift-day-bg', TEXT, 'กะเช้า'],
  ['--dc-shift-mid-fg', '--dc-shift-mid-bg', TEXT, 'กะกลางวัน'],
  ['--dc-shift-eve-fg', '--dc-shift-eve-bg', TEXT, 'กะเย็น'],
  ['--dc-shift-night-fg', '--dc-shift-night-bg', TEXT, 'กะดึก'],
  ['--dc-shift-off-fg', '--dc-shift-off-bg', TEXT, 'วันหยุด'],
  ['--dc-shift-leave-fg', '--dc-shift-leave-bg', TEXT, 'ลา'],
  ['--dc-party-agent', '--dc-surface-raised', TEXT, 'ชื่อผู้พูดฝั่งเอเจนต์'],
  ['--dc-party-contact', '--dc-surface-raised', TEXT, 'ชื่อผู้พูดฝั่งลูกค้า'],
  ['--dc-text-on-brand', '--dc-party-agent', TEXT, 'ข้อความในบับเบิลของเอเจนต์'],

  // องค์ประกอบที่ไม่ใช่ข้อความ — เกณฑ์ 3:1
  ['--dc-success-solid', '--dc-surface-raised', NON_TEXT, 'แถบและไอคอนสำเร็จ'],
  ['--dc-critical-solid', '--dc-surface-raised', NON_TEXT, 'แถบและไอคอนวิกฤต'],
  ['--dc-activity-out-of-adherence', '--dc-surface-raised', NON_TEXT, 'ช่วงหลุด adherence'],

  // ตัวเลขขนาดใหญ่บน wallboard ใช้เกณฑ์ large text ได้
  ['--dc-text-on-inverse', '--dc-surface-inverse', LARGE, 'ตัวเลขบน wallboard'],
];

/**
 * ช่องว่างที่รู้ตัวและยังไม่แก้ — ไม่ทำให้ gate แดง แต่ต้องพิมพ์ออกมาทุกครั้ง
 * ทั้งสองข้อเป็นค่าที่ผู้ใช้อนุมัติไว้ใน mockup แล้ว การแก้จะเปลี่ยนน้ำหนักภาพ
 * ของทุก input และทุกตัวบอกสถานะ "ไม่มีอะไรเกิดขึ้น" ซึ่งเกินขอบเขตของงานสกัด token
 * ต้องให้เจ้าของผลิตภัณฑ์ตัดสิน ไม่ใช่ตัดสินเงียบ ๆ ตอน refactor
 */
const knownGaps = [
  ['--dc-border-default', '--dc-surface-raised', NON_TEXT, 'ขอบ input ตอนพัก (WCAG 1.4.11)'],
  ['--dc-neutral-solid', '--dc-surface-raised', NON_TEXT, 'จุดและแถบสถานะว่าง'],
];

let failed = 0;
const rows = [];
for (const [fg, bg, min, usage] of pairs) {
  const a = tokens.get(fg);
  const b = tokens.get(bg);
  if (!a || !b) {
    console.error(`ไม่พบ token: ${!a ? fg : bg}`);
    failed += 1;
    continue;
  }
  const r = ratio(a, b);
  const ok = r >= min;
  if (!ok) failed += 1;
  rows.push({ ok, r, min, usage, fg, bg });
}

const width = Math.max(...rows.map((row) => row.usage.length));
for (const row of rows) {
  const mark = row.ok ? 'ผ่าน' : 'ตก  ';
  console.log(
    `${mark}  ${row.usage.padEnd(width)}  ${row.r.toFixed(2).padStart(5)}:1  (ต้อง ${row.min})` +
      (row.ok ? '' : `  ← ${row.fg} บน ${row.bg}`),
  );
}

console.log(`\n${rows.length - failed}/${rows.length} คู่ผ่านเกณฑ์ WCAG AA`);

console.log('\nช่องว่างที่รู้ตัว (ยังไม่แก้ รอการตัดสินใจ):');
for (const [fg, bg, min, usage] of knownGaps) {
  const r = ratio(tokens.get(fg), tokens.get(bg));
  console.log(`      ${usage}  ${r.toFixed(2)}:1  (เกณฑ์ ${min})  ${fg}`);
}

process.exit(failed === 0 ? 0 : 1);

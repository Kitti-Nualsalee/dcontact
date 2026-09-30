import { sanitizeDiagnostic } from './phase-zero-readiness.mjs';

const NESTED_DETAIL_CHARACTERS = 1_200;
const TAIL_LINES = 40;

/**
 * #559: acceptance ที่ถูกเรียกซ้อน (เช่น CG4 → S1) พิมพ์ผลเป็น JSON line `readiness.suite`/`readiness.check`
 * ซึ่ง regex แบบ `not ok`/`Error` ไม่จับ — ดึงบรรทัดที่ `status: FAIL` ออกมาพร้อม detail ของชั้นในสุด
 * เพื่อให้ detail ของ suite ชั้นนอกบอกได้ว่าล้มที่ suite ไหน
 */
export function nestedReadinessFailures(output) {
  return sanitizeDiagnostic(output)
    .split('\n')
    .flatMap((line) => {
      const start = line.indexOf('{"type":"readiness.');
      if (start < 0) return [];
      let value;
      try {
        value = JSON.parse(line.slice(start));
      } catch {
        return [];
      }
      if (value?.status !== 'FAIL') return [];
      if (value.type !== 'readiness.suite' && value.type !== 'readiness.check') return [];
      const id = value.id ?? value.checkId ?? 'unknown';
      const command = Array.isArray(value.command) ? ` ${value.command.slice(-2).join(' ')}` : '';
      const detail =
        typeof value.detail === 'string' && value.detail
          ? `: ${
              value.detail.length > NESTED_DETAIL_CHARACTERS
                ? `${value.detail.slice(-NESTED_DETAIL_CHARACTERS)} (ตัดเหลือท้าย)`
                : value.detail
            }`
          : '';
      return [`[nested ${value.type.slice('readiness.'.length)} ${id} FAIL${command}]${detail}`];
    });
}

/** ท้าย output สำหรับกรณีไม่มีบรรทัดไหนบอกความล้มเหลวได้เลย — ดีกว่าเหลือแค่ exit status */
export function outputTail(output, lines = TAIL_LINES) {
  return sanitizeDiagnostic(output).split('\n').filter(Boolean).slice(-lines);
}

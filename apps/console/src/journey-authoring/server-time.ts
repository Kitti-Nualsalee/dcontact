import type { Formatters } from '@d-contact/i18n';

/**
 * เวลาจาก server สำหรับแสดงในตาราง — formatter กลางโยน RangeError เมื่อ parse ไม่ได้ (ตั้งใจให้โค้ดเห็นปัญหา)
 * แต่ข้อมูลแถวเดียวที่ผิดรูปต้องไม่ทำให้ทั้งหน้าพัง จึงแสดงค่าดิบแทน
 */
export function serverTime(formatters: Pick<Formatters, 'dateTime'>, iso: string): string {
  try {
    return formatters.dateTime(iso);
  } catch {
    return iso;
  }
}

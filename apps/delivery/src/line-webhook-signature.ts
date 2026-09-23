/**
 * Owner: Delivery/Channels — raw-body security boundary ของ LINE webhook (S2.5 #369, #359 §B)
 *
 * ลำดับบังคับ: จำกัด method/size → อ่าน raw bytes ตามที่ได้รับ → HMAC-SHA256 ด้วย channel secret
 * → compare แบบ constant-time เท่านั้น จึงจะ decode/parse ได้
 *
 * ห้าม reserialize หรือ normalize body ก่อน verify เพราะ whitespace/emoji ทำให้ digest เปลี่ยน
 * และห้าม log signature หรือ body ในทุกกรณี — ฟังก์ชันที่นี่คืนแค่ boolean กับ code
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** LINE ส่ง body ได้ถึงระดับ MB; ขนาดเกินนี้ปฏิเสธก่อนอ่านเพื่อไม่ให้ ingress เป็นช่องทางถล่ม memory */
export const LINE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

export function lineSignature(rawBody: Buffer, channelSecret: string): string {
  return createHmac('sha256', channelSecret).update(rawBody).digest('base64');
}

/**
 * เทียบ signature แบบ constant-time — ความยาวต่างกันถือว่าไม่ตรงโดยไม่ leak ว่าต่างตรงไหน
 * และไม่โยน error เพื่อไม่ให้ timing ของ exception กลายเป็น oracle
 */
export function verifyLineSignature(
  rawBody: Buffer,
  channelSecret: string,
  headerSignature: string | undefined,
): boolean {
  if (!headerSignature || headerSignature.length === 0) return false;
  const expected = Buffer.from(lineSignature(rawBody, channelSecret), 'utf8');
  const received = Buffer.from(headerSignature, 'utf8');
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

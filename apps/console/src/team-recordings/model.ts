/** #967: กติกาของหน้าเสียงบันทึกของทีมที่ทดสอบได้โดยไม่มี browser */

/** API ส่งเสียงช่วงละไม่เกิน 2 วินาที และ browser กันไว้ล่วงหน้าได้ไม่เกิน 4 วินาที */
export const CHUNK_SECONDS = 2;
export const BUFFER_SECONDS = 4;
export const DEFAULT_RANGE_DAYS = 7;
export const MAX_RANGE_DAYS = 90;
const DAY_MS = 86_400_000;

export interface PlaybackFormat {
  sampleRate: number;
  channels: number;
  totalFrames: number;
  maxChunkFrames: number;
}

/** วันที่ตามเวลาเครื่องผู้ใช้ในรูป YYYY-MM-DD สำหรับ input type="date" */
export function localDate(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function defaultDates(now: Date): { from: string; to: string } {
  return {
    from: localDate(new Date(now.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS)),
    to: localDate(now),
  };
}

export type RangeError = 'INVALID' | 'ORDER' | 'TOO_LONG';

/** ช่วงวันที่ที่ผู้ใช้เลือก (รวมวันสุดท้ายทั้งวัน) เป็นช่วงเวลา UTC ที่ API รับ */
export function dateRange(
  from: string,
  to: string,
): { from: string; to: string } | { error: RangeError } {
  const start = new Date(`${from}T00:00:00`);
  const lastDay = new Date(`${to}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(lastDay.getTime())) return { error: 'INVALID' };
  const end = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1);
  if (end <= start) return { error: 'ORDER' };
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) return { error: 'TOO_LONG' };
  return { from: start.toISOString(), to: end.toISOString() };
}

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** ช่วงถัดไปที่ต้องขอ หรือ null เมื่อถึงท้ายไฟล์ */
export function nextChunk(
  format: PlaybackFormat,
  nextFrame: number,
): { startFrame: number; frameCount: number } | null {
  if (nextFrame >= format.totalFrames) return null;
  const size = Math.min(format.maxChunkFrames, format.sampleRate * CHUNK_SECONDS);
  return { startFrame: nextFrame, frameCount: Math.min(size, format.totalFrames - nextFrame) };
}

/** ขอช่วงถัดไปเมื่อรวมแล้วเสียงที่รอเล่นยังไม่เกิน BUFFER_SECONDS */
export function shouldFetch(bufferedAheadSeconds: number): boolean {
  return bufferedAheadSeconds + CHUNK_SECONDS <= BUFFER_SECONDS;
}

export type PlaybackFailure =
  'signIn' | 'denied' | 'gone' | 'notReady' | 'unsupported' | 'unavailable' | 'failed';

/** สาเหตุที่ผู้ใช้ต้องรู้เมื่อฟังไม่ได้ จาก status และ code ของ API */
export function playbackFailure(status: number, code?: string): PlaybackFailure {
  if (status === 401) return 'signIn';
  if (status === 403) return 'denied';
  if (status === 404) return 'gone';
  if (status === 409 && code === 'RECORDING_NOT_READY') return 'notReady';
  if (status === 422) return 'unsupported';
  if (status === 503 || status === 429) return 'unavailable';
  return 'failed';
}

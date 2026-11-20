/**
 * ตรรกะของการทดสอบอุปกรณ์ (#939) ที่ไม่ผูกกับ browser — ทดสอบได้ด้วยเวลาและระดับเสียงปลอม
 */

export type MicCheck = 'listening' | 'quiet' | 'pass';

export interface SpeechDetectorOptions {
  /** ระดับ RMS (0–1) ที่ถือว่ามีเสียงพูด */
  threshold: number;
  /** เวลาที่มีเสียงพูดรวมกันจนถือว่าผ่าน */
  voicedMs: number;
  /** เงียบนานกว่านี้ = นับเวลาที่มีเสียงพูดใหม่ (ช่วงหยุดหายใจสั้น ๆ ไม่ตัด) */
  gapMs: number;
  /** ยังไม่ผ่านภายในเวลานี้ = แจ้งว่าไม่ได้ยินเสียง แต่ยังฟังต่อ */
  quietMs: number;
}

export const SPEECH_DETECTOR_DEFAULTS: SpeechDetectorOptions = {
  threshold: 0.015,
  voicedMs: 1_000,
  gapMs: 1_500,
  quietMs: 8_000,
};

export interface SpeechDetector {
  /** ส่งระดับเสียงหนึ่งตัวอย่าง พร้อมเวลา (ms) — คืนผลล่าสุด ผ่านแล้วคงผ่าน */
  sample(level: number, now: number): MicCheck;
}

export function createSpeechDetector(options: Partial<SpeechDetectorOptions> = {}): SpeechDetector {
  const { threshold, voicedMs, gapMs, quietMs } = { ...SPEECH_DETECTOR_DEFAULTS, ...options };
  let started: number | undefined;
  let previous: number | undefined;
  let lastVoiced: number | undefined;
  let voiced = 0;
  let passed = false;
  return {
    sample(level, now) {
      if (passed) return 'pass';
      started ??= now;
      const step = previous === undefined ? 0 : Math.max(0, now - previous);
      previous = now;
      if (level >= threshold) {
        if (lastVoiced !== undefined && now - lastVoiced > gapMs) voiced = 0;
        voiced += step;
        lastVoiced = now;
        if (voiced >= voicedMs) {
          passed = true;
          return 'pass';
        }
      }
      return now - started >= quietMs ? 'quiet' : 'listening';
    },
  };
}

/** ระดับเสียง RMS ของ time-domain samples (-1..1) จาก AnalyserNode.getFloatTimeDomainData */
export function rmsLevel(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]!;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

export type MicFailure = 'denied' | 'notFound' | 'busy' | 'failed';

/** แปลง error ของ getUserMedia เป็นเหตุที่บอก Agent ได้ */
export function micFailure(error: unknown): MicFailure {
  const name = error instanceof Error || isNamed(error) ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'notFound';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'failed';
}

function isNamed(value: unknown): value is { name: string } {
  return Boolean(value) && typeof (value as { name?: unknown }).name === 'string';
}

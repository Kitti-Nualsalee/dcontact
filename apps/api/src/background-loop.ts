/**
 * Owner: API runtime — งานเบื้องหลังแบบเป็นรอบ (เช่น sweep ของ work session lease)
 *
 * ทำไมมีไฟล์นี้: `setInterval(() => void work())` ทำให้ rejection หลุดเป็น unhandled rejection แล้ว process
 * ของ API ตาย (เห็นบน UAT 13 พ.ย. 2569 ระหว่าง #901 — `sweep` เจอ Prisma P2028 ตอน VM ช้า)
 *
 * - error ต่อรอบถูกจับและ log แบบ structured (มีแค่ชื่อ loop, ชื่อ error และ code — ไม่มี message
 *   ที่อาจมี query/ข้อมูล) แล้วรอรอบถัดไป
 * - ใช้ setTimeout ต่อกันแทน setInterval เพื่อไม่ให้รอบซ้อนกันตอนที่รอบหนึ่งช้ากว่า interval
 */

export interface BackgroundLoopOptions {
  /** ชื่อ loop ที่ไปอยู่ใน log เช่น `work_session.sweep` */
  name: string;
  intervalMs: number;
  work: () => Promise<unknown>;
  log?: (event: Record<string, unknown>) => void;
  /** ค่าเริ่ม true — timer ไม่รั้ง process ไว้ตอนปิด (test ปิดได้เพื่อรอรอบถัดไป) */
  unref?: boolean;
}

export interface BackgroundLoop {
  /** รันหนึ่งรอบโดยไม่ throw — คืน false ถ้ารอบนั้นล้มเหลว */
  runOnce(): Promise<boolean>;
  stop(): void;
}

const defaultLog = (event: Record<string, unknown>) => console.error(JSON.stringify(event));

/** สรุป error ให้เหลือเฉพาะ field ที่ไม่ใช่ secret/PII */
export function describeBackgroundError(error: unknown): { error: string; code: string | null } {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return {
    error: error instanceof Error ? error.name : 'Unknown',
    code: typeof code === 'string' || typeof code === 'number' ? String(code) : null,
  };
}

export function startBackgroundLoop(options: BackgroundLoopOptions): BackgroundLoop {
  const log = options.log ?? defaultLog;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  async function runOnce(): Promise<boolean> {
    try {
      await options.work();
      return true;
    } catch (error) {
      try {
        log({ event: `${options.name}_failed`, ...describeBackgroundError(error) });
      } catch {
        // logger ล้มเองต้องไม่ทำให้ loop ตาย
      }
      return false;
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      void runOnce().then(schedule);
    }, options.intervalMs);
    if (options.unref !== false) timer.unref?.();
  }

  schedule();
  return {
    runOnce,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

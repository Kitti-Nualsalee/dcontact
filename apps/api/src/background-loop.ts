/**
 * Owner: API runtime — periodic background work (e.g. the work session lease sweep)
 *
 * why this file exists: `setInterval(() => void work())` lets a rejection escape as an unhandled rejection and the API
 * process dies (seen on UAT on 13 Nov 2026 during #901 — `sweep` hit Prisma P2028 when the VM was slow)
 *
 * - the per-round error is caught and logged in a structured way (only the loop name, error name and code — no message
 *   that may contain a query/data) then waits for the next round
 * - chains setTimeout instead of setInterval so rounds do not overlap when one round is slower than the interval
 */

export interface BackgroundLoopOptions {
  /** the loop name that goes into the log, e.g. `work_session.sweep` */
  name: string;
  intervalMs: number;
  work: () => Promise<unknown>;
  log?: (event: Record<string, unknown>) => void;
  /** the default is true — the timer does not hold the process open at shutdown (a test can turn it off to wait for the next round) */
  unref?: boolean;
}

export interface BackgroundLoop {
  /** runs one round without throwing — returns false if that round failed */
  runOnce(): Promise<boolean>;
  stop(): void;
}

const defaultLog = (event: Record<string, unknown>) => console.error(JSON.stringify(event));

/** reduces an error to only fields that are not secret/PII */
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
        // a logger that fails itself must not kill the loop
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

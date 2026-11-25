/**
 * Device-test logic (#939) not tied to the browser — testable with fake time and sound levels
 */

export type MicCheck = 'listening' | 'quiet' | 'pass';

export interface SpeechDetectorOptions {
  /** RMS level (0–1) counted as speech */
  threshold: number;
  /** total speech time counted as pass */
  voicedMs: number;
  /** silence longer than this = restart counting speech time (a short breath pause does not cut it) */
  gapMs: number;
  /** not passed within this time = report that no sound is heard, but keep listening */
  quietMs: number;
}

export const SPEECH_DETECTOR_DEFAULTS: SpeechDetectorOptions = {
  threshold: 0.015,
  voicedMs: 1_000,
  gapMs: 1_500,
  quietMs: 8_000,
};

export interface SpeechDetector {
  /** feed one sound-level sample with its time (ms) — returns the latest result, and once passed it stays passed */
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

/** RMS sound level of time-domain samples (-1..1) from AnalyserNode.getFloatTimeDomainData */
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

/** convert a getUserMedia error into a reason that can be told to the Agent */
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

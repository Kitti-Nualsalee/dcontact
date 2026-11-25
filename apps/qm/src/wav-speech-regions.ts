/**
 * Reads 16-bit PCM WAV and finds the regions with sound on each channel from frame energy.
 * Used by the ASR simulator only; this is not a production VAD.
 */

export class WavFormatError extends Error {
  override readonly name = 'WavFormatError';
}

export interface PcmWav {
  sampleRate: number;
  channels: number;
  /** Samples per channel. */
  frames: number;
  durationMs: number;
  /** Sample of the channel at index (0 = left). */
  sample(frame: number, channel: number): number;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export function parsePcmWav(buffer: Buffer): PcmWav {
  if (
    buffer.length < 12 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new WavFormatError('media is not a RIFF/WAVE file');
  }
  let format: { channels: number; sampleRate: number; bitsPerSample: number } | undefined;
  let data: { offset: number; length: number } | undefined;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buffer.length)
        throw new WavFormatError('fmt chunk is truncated');
      let audioFormat = buffer.readUInt16LE(body);
      if (audioFormat === WAVE_FORMAT_EXTENSIBLE && size >= 40 && body + 26 <= buffer.length) {
        // The sub-format GUID starts at byte 24 of fmt; its first 2 bytes are the real format code
        audioFormat = buffer.readUInt16LE(body + 24);
      }
      if (audioFormat !== WAVE_FORMAT_PCM) throw new WavFormatError('only PCM WAV is supported');
      format = {
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      // An unfinished writer leaves the size at 0 or 0xFFFFFFFF and a truncated file may overstate it: read what is there
      const available = buffer.length - body;
      const streaming = size === 0 || size === 0xffffffff;
      data = { offset: body, length: streaming ? available : Math.min(size, available) };
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format) throw new WavFormatError('fmt chunk is missing');
  if (!data) throw new WavFormatError('data chunk is missing');
  if (format.bitsPerSample !== 16) throw new WavFormatError('only 16-bit PCM is supported');
  if (format.channels < 1 || format.channels > 2) {
    throw new WavFormatError('only mono or stereo WAV is supported');
  }
  if (format.sampleRate < 8_000 || format.sampleRate > 48_000) {
    throw new WavFormatError('sample rate must be between 8000 and 48000 Hz');
  }
  const { channels, sampleRate } = format;
  const blockAlign = channels * 2;
  const frames = Math.floor(data.length / blockAlign);
  const start = data.offset;
  return {
    sampleRate,
    channels,
    frames,
    durationMs: Math.floor((frames * 1_000) / sampleRate),
    sample: (frame, channel) => buffer.readInt16LE(start + frame * blockAlign + channel * 2),
  };
}

export interface SpeechRegion {
  startMs: number;
  endMs: number;
}

export interface SpeechRegionOptions {
  frameMs?: number;
  /** Minimum RMS (int16) that counts as sound. */
  minRms?: number;
  /** Gaps shorter than this are merged into one region. */
  mergeGapMs?: number;
  /** Regions shorter than this are dropped. */
  minRegionMs?: number;
  /** Regions longer than this are split into several segments. */
  maxRegionMs?: number;
  /** Threshold cap: on a channel that is loud for most of the call (hold music, looped audio) the noise floor would hide all speech. */
  maxThresholdRms?: number;
}

const DEFAULTS: Required<SpeechRegionOptions> = {
  frameMs: 20,
  minRms: 400,
  mergeGapMs: 300,
  minRegionMs: 250,
  maxRegionMs: 15_000,
  maxThresholdRms: 1_500,
};

/** Finds sound regions of one channel: threshold = 4x the 20th-percentile noise floor, clamped to [minRms, maxThresholdRms]. */
export function detectSpeechRegions(
  wav: PcmWav,
  channel: number,
  options: SpeechRegionOptions = {},
): SpeechRegion[] {
  const settings = { ...DEFAULTS, ...options };
  const frameSamples = Math.max(1, Math.round((wav.sampleRate * settings.frameMs) / 1_000));
  const windows = Math.floor(wav.frames / frameSamples);
  if (windows === 0) return [];
  const rms = new Float64Array(windows);
  for (let window = 0; window < windows; window += 1) {
    let sum = 0;
    const first = window * frameSamples;
    for (let index = 0; index < frameSamples; index += 1) {
      const value = wav.sample(first + index, channel);
      sum += value * value;
    }
    rms[window] = Math.sqrt(sum / frameSamples);
  }
  const sorted = Float64Array.from(rms).sort();
  const noiseFloor = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
  const threshold = Math.max(settings.minRms, Math.min(settings.maxThresholdRms, noiseFloor * 4));
  const toMs = (window: number) => Math.round((window * frameSamples * 1_000) / wav.sampleRate);

  const raw: SpeechRegion[] = [];
  let open: number | undefined;
  for (let window = 0; window <= windows; window += 1) {
    const active = window < windows && (rms[window] ?? 0) >= threshold;
    if (active && open === undefined) open = window;
    if (!active && open !== undefined) {
      raw.push({ startMs: toMs(open), endMs: toMs(window) });
      open = undefined;
    }
  }

  const merged: SpeechRegion[] = [];
  for (const region of raw) {
    const last = merged.at(-1);
    if (last && region.startMs - last.endMs < settings.mergeGapMs) last.endMs = region.endMs;
    else merged.push({ ...region });
  }

  const regions: SpeechRegion[] = [];
  for (const region of merged) {
    if (region.endMs - region.startMs < settings.minRegionMs) continue;
    for (let start = region.startMs; start < region.endMs; start += settings.maxRegionMs) {
      regions.push({ startMs: start, endMs: Math.min(region.endMs, start + settings.maxRegionMs) });
    }
  }
  return regions;
}

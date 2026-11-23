/**
 * อ่าน WAV แบบ PCM 16-bit แล้วหาช่วงที่มีเสียงในแต่ละ channel ด้วยพลังงานของ frame
 * ใช้ใน ASR simulator เท่านั้น ไม่ใช่ VAD สำหรับงานจริง
 */

export class WavFormatError extends Error {
  override readonly name = 'WavFormatError';
}

export interface PcmWav {
  sampleRate: number;
  channels: number;
  /** จำนวน sample ต่อ channel */
  frames: number;
  durationMs: number;
  /** sample ของ channel ที่ index (0 = ซ้าย) */
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
        // sub-format GUID เริ่มที่ byte 24 ของ fmt; 2 byte แรกคือ format code จริง
        audioFormat = buffer.readUInt16LE(body + 24);
      }
      if (audioFormat !== WAVE_FORMAT_PCM) throw new WavFormatError('only PCM WAV is supported');
      format = {
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      // writer ที่ยังไม่ปิดไฟล์เขียนขนาดเป็น 0 หรือ 0xFFFFFFFF และไฟล์ที่ถูกตัดกลางคันอาจมีขนาดเกินจริง: อ่านเท่าที่มี
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
  /** RMS ขั้นต่ำ (int16) ที่ถือว่ามีเสียง */
  minRms?: number;
  /** ช่องว่างที่สั้นกว่านี้ถูกรวมเป็นช่วงเดียว */
  mergeGapMs?: number;
  /** ช่วงที่สั้นกว่านี้ถูกตัดทิ้ง */
  minRegionMs?: number;
  /** ช่วงที่ยาวกว่านี้ถูกแบ่งเป็นหลาย segment */
  maxRegionMs?: number;
  /** เพดานของเกณฑ์: channel ที่มีเสียงเกือบทั้งสาย (เพลงรอสาย, เสียงวน) noise floor จะสูงจนไม่เจอเสียงพูดเลย */
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

/** หาช่วงที่มีเสียงของ channel เดียว: เกณฑ์ = 4 เท่าของ noise floor ที่ percentile 20 อยู่ระหว่าง minRms ถึง maxThresholdRms */
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

/**
 * #967: reads the header of a WAV file that Telephony archived and builds a short WAV range to send to the browser
 *
 * supports only 16-bit PCM mono or stereo; other formats are rejected, with no guessing of offsets
 */
export const RECORDING_CHUNK_SECONDS = 2;
/** the size read to find the `fmt ` and `data` chunks; a FreeSWITCH file has a header of roughly 44–100 bytes */
export const WAV_HEADER_PROBE_BYTES = 4096;

export interface WavFormat {
  /** the first byte of PCM in the source file */
  dataOffset: number;
  sampleRate: number;
  channels: 1 | 2;
  totalFrames: number;
}

export class WavFormatError extends Error {}

const ascii = (bytes: Buffer, offset: number) => bytes.toString('latin1', offset, offset + 4);

/** `objectBytes` is the real file size in storage, used to cut a data length that the header claims beyond the file */
export function parseWavHeader(bytes: Buffer, objectBytes: number): WavFormat {
  if (bytes.length < 12 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WAVE') {
    throw new WavFormatError('not a RIFF/WAVE file');
  }
  let offset = 12;
  let format: { sampleRate: number; channels: 1 | 2 } | undefined;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) throw new WavFormatError('fmt chunk is truncated');
      const encoding = bytes.readUInt16LE(body);
      const channels = bytes.readUInt16LE(body + 2);
      const sampleRate = bytes.readUInt32LE(body + 4);
      const blockAlign = bytes.readUInt16LE(body + 12);
      const bitsPerSample = bytes.readUInt16LE(body + 14);
      if (encoding !== 1 || bitsPerSample !== 16) throw new WavFormatError('not PCM 16 bit');
      if (channels !== 1 && channels !== 2) throw new WavFormatError('unsupported channel count');
      if (sampleRate < 8_000 || sampleRate > 48_000) throw new WavFormatError('unsupported rate');
      if (blockAlign !== channels * 2) throw new WavFormatError('unexpected block align');
      format = { sampleRate, channels };
    } else if (id === 'data') {
      if (!format) throw new WavFormatError('data chunk precedes fmt chunk');
      // a FreeSWITCH that stopped abruptly may leave the data size as 0 or beyond the file, so the real file size is used
      const available = Math.max(0, objectBytes - body);
      const dataBytes = size === 0 || size > available ? available : size;
      const frameBytes = format.channels * 2;
      return { dataOffset: body, ...format, totalFrames: Math.floor(dataBytes / frameBytes) };
    }
    offset = body + size + (size % 2);
  }
  throw new WavFormatError('data chunk not found in header probe');
}

/** a self-playable WAV: a 44-byte header followed by the PCM of the requested range */
export function wavChunk(format: Pick<WavFormat, 'sampleRate' | 'channels'>, pcm: Buffer): Buffer {
  const frameBytes = format.channels * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.sampleRate * frameBytes, 28);
  header.writeUInt16LE(frameBytes, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** the byte range in the source file of the requested frames, clipped to the file length */
export function frameByteRange(
  format: WavFormat,
  startFrame: number,
  frameCount: number,
): { start: number; endInclusive: number; frames: number } {
  const frames = Math.min(frameCount, format.totalFrames - startFrame);
  const frameBytes = format.channels * 2;
  const start = format.dataOffset + startFrame * frameBytes;
  return { start, endInclusive: start + frames * frameBytes - 1, frames };
}

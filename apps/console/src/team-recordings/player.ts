/**
 * #967: play a recording from short WAV ranges requested one at a time through the API.
 *
 * Look-ahead audio is capped at BUFFER_SECONDS, and queued audio is dropped immediately on stop, seek,
 * or API rejection, so a permission revocation takes effect within that bound — the whole file is never loaded.
 */
import { RecordingApiError, type PlaybackSession, type TeamRecordingsApi } from './api.js';
import { nextChunk, shouldFetch } from './model.js';

export type PlayerPhase = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';
export interface PlayerState {
  phase: PlayerPhase;
  /** seconds from the start of the file */
  position: number;
  /** null until the session is open and the real file length is known */
  duration: number | null;
  error?: { status: number; code?: string };
}

const TICK_MS = 200;

export class ChunkPlayer {
  private context?: AudioContext;
  private session?: PlaybackSession;
  private sources = new Set<AudioBufferSourceNode>();
  private phase: PlayerPhase = 'idle';
  private error?: { status: number; code?: string };
  /** next frame not yet requested */
  private nextFrame = 0;
  /** time in the AudioContext when the queued audio finishes playing */
  private scheduledUntil = 0;
  /** reference point between AudioContext time and the position in the file */
  private anchor = { time: 0, position: 0 };
  private restingPosition = 0;
  /** incremented on every stop or seek; answers from an older round that arrive later are dropped */
  private generation = 0;
  private fetching = false;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private duration: number | null = null;

  constructor(
    private readonly api: TeamRecordingsApi,
    private readonly recordingId: string,
    private readonly onState: (state: PlayerState) => void,
    private readonly createContext: () => AudioContext = () => new AudioContext(),
  ) {}

  state(): PlayerState {
    const format = this.session?.format;
    // remember the length even if the session is dropped after an error so the time bar does not vanish
    if (format) this.duration = format.totalFrames / format.sampleRate;
    return {
      phase: this.phase,
      position: this.position(),
      duration: this.duration,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async play(): Promise<void> {
    if (this.disposed || this.phase === 'playing' || this.phase === 'loading') return;
    if (this.phase === 'ended') this.restingPosition = 0;
    this.error = undefined;
    this.set('loading');
    const generation = ++this.generation;
    try {
      this.context ??= this.createContext();
      await this.context.resume();
      if (!this.session) {
        const opened = await this.api.open(this.recordingId);
        // the player was closed while waiting: do not leave a session open on the server
        if (this.disposed) return this.release(opened);
        this.session = opened;
      }
      if (generation !== this.generation) return;
      this.nextFrame = Math.round(this.restingPosition * this.session.format.sampleRate);
      this.scheduledUntil = 0;
      this.anchor = { time: this.context.currentTime, position: this.restingPosition };
      this.timer ??= setInterval(() => void this.pump(), TICK_MS);
      await this.pump();
    } catch (failure) {
      if (generation === this.generation) this.fail(failure);
    }
  }

  pause(): void {
    if (this.phase !== 'playing' && this.phase !== 'loading') return;
    this.restingPosition = this.position();
    this.flush();
    this.set('paused');
  }

  /** seek: drop queued audio and request a new range, which the API permission-checks again */
  seek(seconds: number): void {
    const duration = this.state().duration ?? 0;
    const wasPlaying = this.phase === 'playing' || this.phase === 'loading';
    this.restingPosition = Math.min(Math.max(0, seconds), duration);
    this.flush();
    if (wasPlaying) {
      this.phase = 'paused';
      void this.play();
    } else {
      this.set(this.phase === 'ended' ? 'paused' : this.phase);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.flush();
    if (this.timer) clearInterval(this.timer);
    const session = this.session;
    this.session = undefined;
    this.release(session);
    void this.context?.close().catch(() => undefined);
  }

  private position(): number {
    const format = this.session?.format;
    if (!format || !this.context || (this.phase !== 'playing' && this.phase !== 'loading')) {
      return this.restingPosition;
    }
    const scheduled = this.nextFrame / format.sampleRate;
    const elapsed = this.anchor.position + (this.context.currentTime - this.anchor.time);
    return Math.min(Math.max(this.restingPosition, elapsed), scheduled);
  }

  private async pump(): Promise<void> {
    const { context, session } = this;
    if (!context || !session || this.disposed) return;
    if (this.phase !== 'playing' && this.phase !== 'loading') return;
    const generation = this.generation;
    const ahead = Math.max(0, this.scheduledUntil - context.currentTime);
    const request = nextChunk(session.format, this.nextFrame);
    if (!request) {
      if (ahead === 0) {
        this.restingPosition = session.format.totalFrames / session.format.sampleRate;
        this.flush();
        this.set('ended');
      } else this.emit();
      return;
    }
    if (this.fetching || !shouldFetch(ahead)) return this.emit();
    this.fetching = true;
    try {
      const bytes = await this.fetchChunk(request.startFrame, request.frameCount);
      const buffer = await context.decodeAudioData(bytes);
      // stopped, sought or rejected while waiting: do not play audio from the old round
      if (generation !== this.generation || this.disposed) return;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const startAt = Math.max(this.scheduledUntil, context.currentTime);
      source.onended = () => this.sources.delete(source);
      source.start(startAt);
      this.sources.add(source);
      this.anchor = { time: startAt, position: request.startFrame / session.format.sampleRate };
      this.scheduledUntil = startAt + buffer.duration;
      this.nextFrame = request.startFrame + request.frameCount;
      this.set('playing');
    } catch (failure) {
      if (generation === this.generation) this.fail(failure);
    } finally {
      this.fetching = false;
    }
  }

  /** session expired while listening: reopen once, which re-checks the current permission */
  private async fetchChunk(startFrame: number, frameCount: number): Promise<ArrayBuffer> {
    const session = this.session!;
    try {
      return await this.api.chunk(this.recordingId, session.sessionId, startFrame, frameCount);
    } catch (failure) {
      if (
        !(failure instanceof RecordingApiError) ||
        failure.status !== 409 ||
        failure.code !== 'PLAYBACK_SESSION_EXPIRED'
      ) {
        throw failure;
      }
      this.session = await this.api.open(this.recordingId);
      return this.api.chunk(this.recordingId, this.session.sessionId, startFrame, frameCount);
    }
  }

  /** drop all queued audio immediately */
  private flush(): void {
    this.generation += 1;
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // source that has not started or has already ended
      }
      source.disconnect();
    }
    this.sources.clear();
    this.scheduledUntil = 0;
  }

  /** close a session that is no longer used; may fail, because the server closes it on its own on expiry or reopen */
  private release(session: PlaybackSession | undefined): void {
    if (session) void this.api.close(this.recordingId, session.sessionId).catch(() => undefined);
  }

  private fail(failure: unknown): void {
    this.restingPosition = this.position();
    this.flush();
    this.error =
      failure instanceof RecordingApiError
        ? { status: failure.status, ...(failure.code ? { code: failure.code } : {}) }
        : { status: 0 };
    // permission or session can no longer be used: the next round must reopen
    if (this.error.status !== 0) {
      this.release(this.session);
      this.session = undefined;
    }
    this.set('error');
  }

  private set(phase: PlayerPhase): void {
    this.phase = phase;
    this.emit();
  }

  private emit(): void {
    if (!this.disposed) this.onState(this.state());
  }
}

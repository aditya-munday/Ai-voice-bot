import { Emitter } from './events.js';
import type { TtsServerMessage } from '../protocol.js';

/** Audio clock lead before the first frame. Absorbs jitter without an audible delay. */
const LEAD_SECONDS = 0.06;

/** How long the audio stream must be silent before the turn is considered over. */
const QUIET_MS = 350;

/**
 * Streaming speech player.
 *
 * Owns one persistent WebSocket to the server's TTS relay and a Web Audio
 * timeline. Each PCM frame that arrives is placed on the timeline at an exact
 * time, so consecutive frames abut: unlike chaining `<audio>` elements, the next
 * buffer is scheduled while the previous one is still sounding, which removes the
 * per-clip start latency and the gap between clips.
 *
 * A small lead (LEAD_SECONDS) is kept ahead of the clock. If the producer falls
 * behind — a slow segment, a GC pause — the timeline is re-anchored rather than
 * glitching.
 *
 * Frames are scheduled one buffer per network frame, at whatever size it arrives.
 * An earlier version re-blocked them into fixed 1024-sample buffers; that left a
 * sub-frame remainder stranded in a queue, which then needed a "flush" step and a
 * guess at when the producer had really stopped. Scheduling each frame as it comes
 * removes the remainder, and with it the guess.
 */
export class SpeechPlayer {
  readonly speaking = new Emitter<boolean>();
  readonly errors = new Emitter<string>();
  /** First PCM frame of the current context arrived. Fires once per context. */
  readonly firstFrame = new Emitter<void>();
  /** Audio actually started sounding for the current context. Once per context. */
  readonly firstPlayed = new Emitter<void>();

  private sawFrame = false;
  private sawPlayed = false;
  private playTimer: ReturnType<typeof setTimeout> | null = null;

  private socket: WebSocket | null = null;
  private opened: Promise<void> | null = null;

  private context: AudioContext | null = null;
  private sampleRate = 24000;

  private scheduledUntil = 0;
  private live = 0;
  private active = false;
  private generation = 0;
  /**
   * Generation of the context currently open. The relay ends a turn late on
   * purpose, once the provider has released the context, so an `tts_end` for the
   * previous turn can arrive after the next one has already begun. Acting on it
   * would end the new turn before it spoke, so control messages are ignored
   * unless they belong to the context this player is on.
   */
  private openGeneration = -1;

  /**
   * End-of-turn tracking. `tts_end` means "the context is closed", which is *not*
   * the same as "all audio has arrived": the provider emits no frame for that, and
   * the close can even reach us before the last frames do. So the turn ends when
   * the text is complete, every scheduled buffer has finished, and no new audio
   * has arrived for a short quiet period.
   */
  private textDone = false;
  private lastAudioAt = 0;
  private finishTimer: ReturnType<typeof setInterval> | null = null;
  private finishDeadline = 0;

  /** Open a synthesis context and begin a fresh playback timeline. */
  async begin(): Promise<void> {
    this.cancel();
    const generation = this.generation;

    await this.ensureSocket().catch((err: unknown) => {
      this.errors.emit(err instanceof Error ? err.message : String(err));
    });
    if (generation !== this.generation || !this.socket) return;

    this.resetTimeline();
    this.setActive(true);
    this.openGeneration = generation;
    // 0 = "use the server's configured rate"; the relay echoes it in `tts_ready`,
    // which is what the playback buffers are built with.
    this.socket.send(JSON.stringify({ type: 'tts_start', sampleRate: 0 }));
  }

  /** Append a speakable fragment. */
  push(text: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (!text) return;
    this.socket.send(JSON.stringify({ type: 'tts_text', text }));
  }

  /** No more text for this utterance. */
  finish(): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'tts_finish' }));
    this.beginFinish();
  }

  /** Stop everything: drop queued audio, silence the timeline, abandon synthesis. */
  cancel(): void {
    this.generation++;
    this.stopFinishWatchdog();
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'tts_cancel' }));
    this.resetTimeline();
    this.setActive(false);
  }

  get isSpeaking(): boolean {
    return this.active;
  }

  private setActive(next: boolean): void {
    if (this.active === next) return;
    this.active = next;
    this.speaking.emit(next);
  }

  private resetTimeline(): void {
    this.scheduledUntil = 0;
    this.live = 0;
    this.textDone = false;
    this.lastAudioAt = Date.now();
    this.sawFrame = false;
    this.sawPlayed = false;
    if (this.playTimer) clearTimeout(this.playTimer);
    this.playTimer = null;
  }

  /* ---------------------------------------------------------------- *
   * End of turn
   * ---------------------------------------------------------------- */

  private beginFinish(): void {
    this.textDone = true;
    this.lastAudioAt = Date.now();
    this.finishDeadline = Date.now() + 6000;
    this.stopFinishWatchdog();
    this.finishTimer = setInterval(() => this.maybeEnd(), 100);
    this.maybeEnd();
  }

  private maybeEnd(): void {
    if (!this.textDone) return;
    const quiet = Date.now() - this.lastAudioAt;
    const drained = this.live === 0 && quiet >= QUIET_MS;
    const past = Date.now() > this.finishDeadline;
    if (!drained && !past) return;
    this.textDone = false;
    this.stopFinishWatchdog();
    this.setActive(false);
  }

  private stopFinishWatchdog(): void {
    if (this.finishTimer) clearInterval(this.finishTimer);
    this.finishTimer = null;
  }

  /* ---------------------------------------------------------------- *
   * Socket
   * ---------------------------------------------------------------- */

  /** Resolve once the relay socket is connected and usable. */
  private ensureSocket(): Promise<void> {
    if (this.opened) return this.opened;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}/api/tts`);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    this.opened = new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('could not reach the speech service'));
      socket.onclose = () => {
        this.opened = null;
        if (this.socket === socket) this.socket = null;
      };
      socket.onmessage = (event: MessageEvent) => this.onMessage(event);
    });
    return this.opened;
  }

  private onMessage(event: MessageEvent): void {
    if (event.data instanceof ArrayBuffer) {
      this.onAudio(event.data);
      return;
    }
    let message: TtsServerMessage;
    try {
      message = JSON.parse(String(event.data)) as TtsServerMessage;
    } catch {
      return;
    }
    switch (message.type) {
      case 'tts_ready':
        this.sampleRate = message.sampleRate || this.sampleRate;
        break;
      case 'tts_end':
        // Belongs to a context this player is no longer on: a late end for the
        // previous turn, arriving after a new one began.
        if (this.openGeneration !== this.generation) break;
        // The relay only sends this once the provider has released the context,
        // so no more audio is coming. Play out what is queued rather than cutting
        // it off.
        this.beginFinish();
        break;
      case 'tts_error':
        this.errors.emit(message.message);
        break;
    }
  }

  private onAudio(buffer: ArrayBuffer): void {
    // Frames are PCM16, so an odd byte count would throw in the typed-array view.
    if (buffer.byteLength < 2) return;
    const view = new Int16Array(buffer, 0, buffer.byteLength >> 1);
    if (!view.length) return;
    const samples = new Float32Array(view.length);
    for (let i = 0; i < view.length; i++) {
      const s = view[i]!;
      samples[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
    }
    this.lastAudioAt = Date.now();
    if (!this.sawFrame) {
      this.sawFrame = true;
      this.firstFrame.emit();
    }
    this.schedule(samples);
  }

  private schedule(samples: Float32Array): void {
    const context = this.context;
    if (!context) return;
    const duration = samples.length / this.sampleRate;
    const now = context.currentTime;
    // Re-anchor if the producer fell behind the clock (underrun) or on the first block.
    if (this.scheduledUntil < now + LEAD_SECONDS) this.scheduledUntil = now + LEAD_SECONDS;

    const node = context.createBufferSource();
    const buffer = context.createBuffer(1, samples.length, this.sampleRate);
    buffer.getChannelData(0).set(samples);
    node.buffer = buffer;
    node.connect(context.destination);
    const startAt = this.scheduledUntil;
    node.start(startAt);
    this.scheduledUntil += duration;
    this.live++;
    // Approximate "audio is audible now" from the audio clock. In headless Chromium
    // there is no sink and currentTime never advances, so this is a debug mark, not
    // a gate: nothing in the turn path waits on it.
    if (!this.sawPlayed) {
      this.sawPlayed = true;
      const delayMs = Math.max(0, (startAt - now) * 1000);
      this.playTimer = setTimeout(() => this.firstPlayed.emit(), delayMs);
    }
    node.onended = () => {
      this.live--;
      this.maybeEnd();
    };
  }

  private getAudioContext(): AudioContext {
    if (!this.context) this.context = new AudioContext({ latencyHint: 'interactive' });
    return this.context;
  }

  /** Must be called from a user gesture before the first utterance. */
  async resume(): Promise<void> {
    const context = this.getAudioContext();
    if (context.state === 'suspended') await context.resume().catch(() => undefined);
    // Prime the socket so the first turn is not paying for the handshake.
    void this.ensureSocket().catch(() => undefined);
  }
}

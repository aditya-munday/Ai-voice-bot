import { Emitter } from './events.js';
import type { TtsServerMessage } from '../protocol.js';

/**
 * Streaming speech player.
 *
 * Owns one persistent WebSocket to the server's TTS relay and a Web Audio
 * timeline. PCM frames are pushed into a scheduling queue and played through
 * `AudioBufferSourceNode`s placed at exact times, which is what keeps the speech
 * gapless: unlike chaining `<audio>` elements, one node can be scheduled while
 * the previous is still sounding, so there is no per-clip start latency.
 *
 * A small lead (LEAD_SECONDS) is kept ahead of the clock. If the producer ever
 * falls behind — a slow segment, a GC pause — the timeline is re-anchored
 * instead of glitching.
 */

/** Fixed scheduling block. ~43 ms at 24 kHz: short enough to be responsive,
 *  long enough that we are not creating a node per network frame. */
const FRAME_SAMPLES = 1024;

/** Audio clock lead before the first block. Absorbs jitter without an audible delay. */
const LEAD_SECONDS = 0.06;

export class SpeechPlayer {
  readonly speaking = new Emitter<boolean>();
  readonly errors = new Emitter<string>();

  private socket: WebSocket | null = null;
  private opened: Promise<void> | null = null;

  private context: AudioContext | null = null;
  private sampleRate = 24000;

  private chunks: Float32Array[] = [];
  private available = 0;
  private scheduledUntil = 0;
  private live = 0;
  private active = false;
  private generation = 0;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;

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
    // The service's terminal frame can lag the last audio frame by seconds, so
    // do not depend on it to leave the speaking state. Arm a watchdog that ends
    // the turn once the audio clock has passed the end of scheduled playback;
    // any later frame that arrives just cancels it.
    this.armFinishWatchdog();
  }

  /** Stop everything: drop queued audio, silence the timeline, abandon synthesis. */
  cancel(): void {
    this.generation++;
    this.clearFinishWatchdog();
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'tts_cancel' }));
    this.resetTimeline();
    this.setActive(false);
  }

  private clearFinishWatchdog(): void {
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = null;
  }

  private armFinishWatchdog(): void {
    this.clearFinishWatchdog();
    const generation = this.generation;
    const context = this.context;
    // How much audio is still queued ahead of the playhead. Measured once, then
    // driven by the wall clock: re-reading the audio clock each tick would hang
    // forever if it never advances (an environment with no audio sink).
    const remaining = context ? Math.max(0, this.scheduledUntil - context.currentTime) : 0;
    this.finishTimer = setTimeout(
      () => {
        if (generation !== this.generation) return;
        this.finishTimeline();
        // Buffers can still be mid-playback if the clock ran slower than the
        // timer; `onended` is the backstop for that case.
        if (this.live === 0) this.setActive(false);
      },
      remaining * 1000 + 150,
    );
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
    this.chunks.length = 0;
    this.available = 0;
    this.scheduledUntil = 0;
    this.live = 0;
  }

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
        this.clearFinishWatchdog();
        this.finishTimeline();
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
    this.chunks.push(samples);
    this.available += samples.length;
    this.drain();
  }

  private drain(): void {
    while (this.available >= FRAME_SAMPLES) {
      const frame = this.take(FRAME_SAMPLES);
      this.schedule(frame);
    }
  }

  private take(count: number): Float32Array {
    const out = new Float32Array(count);
    let written = 0;
    while (written < count && this.chunks.length) {
      const head = this.chunks[0]!;
      const need = count - written;
      if (head.length <= need) {
        out.set(head, written);
        written += head.length;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), written);
        this.chunks[0] = head.subarray(need);
        written += need;
      }
    }
    this.available -= written;
    return out;
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
    node.start(this.scheduledUntil);
    this.scheduledUntil += duration;
    this.live++;
    node.onended = () => {
      this.live--;
      if (this.live <= 0 && this.available < FRAME_SAMPLES) this.setActive(false);
    };
  }

  /** Flush the sub-frame tail and let playback drain. */
  private finishTimeline(): void {
    if (this.available > 0) {
      this.schedule(this.take(this.available));
      this.available = 0;
    }
    if (this.live === 0) this.setActive(false);
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

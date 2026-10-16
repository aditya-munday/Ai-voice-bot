import { Emitter } from './events.js';
import type { SttServerMessage } from '../protocol.js';

export type RecorderState = 'idle' | 'starting' | 'recording';

export type FinalTranscript = { type: 'final'; text: string };
export type PartialTranscript = { type: 'partial'; text: string };
export type SttEvent = FinalTranscript | PartialTranscript;

const TARGET_SAMPLE_RATE = 16000;

/**
 * Push-to-talk microphone capture.
 *
 * The transcription socket is opened once and kept for the life of the page:
 * reconnecting per turn would add a handshake to the front of every utterance,
 * which is exactly the latency this project exists to avoid. Audio only flows
 * while the button is held; between turns the socket simply sits ready.
 *
 * Capture itself lives in an AudioWorklet, so resampling and framing never touch
 * the main thread.
 */
export class Recorder {
  readonly transcripts = new Emitter<SttEvent>();
  readonly level = new Emitter<number>();
  readonly errors = new Emitter<string>();
  readonly state = new Emitter<RecorderState>();

  private socket: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private current: RecorderState = 'idle';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every start/stop so a slow start can detect it was cancelled. */
  private turn = 0;

  private setState(next: RecorderState): void {
    this.current = next;
    this.state.emit(next);
  }

  get isRecording(): boolean {
    return this.current === 'recording';
  }

  /** Grant a reusable mic stream. Call from a user gesture, before the first turn. */
  async prime(): Promise<void> {
    await this.ensureSocket().catch(() => undefined);
    try {
      await this.ensureStream();
      // Kick the AudioContext into `running` now; resuming later costs a frame.
      const context = this.getContext();
      if (context.state === 'suspended') await context.resume().catch(() => undefined);
    } catch (err) {
      this.errors.emit(err instanceof Error ? err.message : String(err));
    }
  }

  async start(): Promise<void> {
    if (this.current !== 'idle') return;
    const turn = ++this.turn;
    this.setState('starting');
    try {
      await this.ensureSocket();
      await this.ensureStream();

      const context = this.getContext();
      await context.audioWorklet.addModule('/pcm-worklet.js');

      // The button may already have been released while the graph was being
      // built (a quick tap, or a slow permission prompt). Bail out rather than
      // leaving a live capture graph streaming with nothing to stop it.
      if (turn !== this.turn) return;

      this.source = context.createMediaStreamSource(this.stream!);
      this.node = new AudioWorkletNode(context, 'pcm16-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE },
      });

      this.node.port.onmessage = (event: MessageEvent) => {
        const data = event.data as { type: string; pcm?: Int16Array; rms?: number; last?: boolean };
        if (data.type === 'audio' && data.pcm) {
          this.send(data.pcm);
          if (data.last) this.finalizeTurn();
        } else if (data.type === 'flushed') {
          this.finalizeTurn();
        } else if (data.type === 'level' && typeof data.rms === 'number') {
          this.level.emit(Math.min(1, data.rms * 4.5));
        }
      };

      this.source.connect(this.node);
      await context.resume();
      this.setState('recording');
    } catch (err) {
      this.errors.emit(err instanceof Error ? err.message : String(err));
      await this.teardownGraph();
      this.setState('idle');
    }
  }

  /**
   * Ends the utterance. The worklet still holds up to one chunk of audio, so ask
   * it to flush first and only send `finalize` once that tail is on the wire —
   * otherwise releasing the button can clip the last word. The socket stays open.
   */
  stop(): void {
    if (this.current === 'idle') return;
    this.turn++;
    this.setState('idle');
    if (!this.node) return;
    this.node.port.postMessage({ type: 'flush' });
    // Safety net in case the worklet never answers; finalize anyway.
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.finalizeTurn(), 120);
  }

  private finalizeTurn(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'finalize' }));
    }
    void this.teardownGraph();
  }

  private getContext(): AudioContext {
    if (!this.context) this.context = new AudioContext({ latencyHint: 'interactive' });
    return this.context;
  }

  private async ensureStream(): Promise<void> {
    if (this.stream) return;
    // Echo cancellation and noise suppression matter here: the assistant's own
    // speech can otherwise loop back into the mic on open speakers and be
    // transcribed as a user turn.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    stream.getAudioTracks().forEach((track) => {
      // A track that ends (device unplugged, permission revoked) invalidates the
      // whole stream, so drop it and reacquire on the next turn.
      track.addEventListener('ended', () => {
        if (this.stream !== stream) return;
        this.stream = null;
        this.source?.disconnect();
        this.source = null;
      });
    });
    this.stream = stream;
  }

  private ensureSocket(): Promise<void> {
    if (this.ready) return this.ready;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}/api/stt`);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    this.ready = new Promise<void>((resolve, reject) => {
      const failEarly = (): void => reject(new Error('could not reach the speech service'));
      socket.onopen = () => resolve();
      socket.onerror = failEarly;
      socket.onclose = () => {
        this.ready = null;
        this.socket = null;
      };
      socket.onmessage = (event: MessageEvent) => this.onMessage(event);
    });
    return this.ready;
  }

  private onMessage(event: MessageEvent): void {
    let data: SttServerMessage;
    try {
      data = JSON.parse(typeof event.data === 'string' ? event.data : '') as SttServerMessage;
    } catch {
      return;
    }
    if (data.type === 'error') {
      this.errors.emit(data.message);
      return;
    }
    if (data.type === 'transcript') {
      const text = data.text.trim();
      if (!text) return;
      this.transcripts.emit(data.final ? { type: 'final', text } : { type: 'partial', text });
    }
  }

  private send(pcm: Int16Array): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    // The worklet transfers ownership of each chunk's buffer to this thread, so
    // it is already private and can go straight out.
    this.socket.send(pcm.buffer as ArrayBuffer);
  }

  /** Tear down only the capture graph; the socket and stream are reused. */
  private async teardownGraph(): Promise<void> {
    this.node?.port.close();
    this.node?.disconnect();
    this.node = null;

    this.source?.disconnect();
    this.source = null;

    this.level.emit(0);
  }
}

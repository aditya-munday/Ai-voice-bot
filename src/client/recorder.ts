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

  /**
   * Provider VAD closes an utterance on its own, mid-hold, wherever it hears a
   * pause. Treating that as the end of the user's turn answers them while they
   * are still holding the button, and the release then starts a second turn. So
   * the provider's finals are *accumulated* here instead: the user's turn ends
   * only when they release, and the transcript is every segment heard so far.
   */
  private segments: string[] = [];
  private partial = '';
  private stopped = false;
  private finalTimer: ReturnType<typeof setTimeout> | null = null;
  /** Samples sent since the provider last finalized, i.e. its unconfirmed tail. */
  private audioSinceFinal = 0;

  private setState(next: RecorderState): void {
    this.current = next;
    this.state.emit(next);
  }

  get isRecording(): boolean {
    return this.current === 'recording';
  }

  /** True between button release and the turn's final transcript being emitted. */
  get isFinalizing(): boolean {
    return this.stopped;
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
    // A previous turn's finalize may still be pending; it must not emit into this
    // one, so drop it along with the text it was waiting on.
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.finalTimer) clearTimeout(this.finalTimer);
    this.flushTimer = null;
    this.finalTimer = null;
    this.segments = [];
    this.partial = '';
    this.stopped = false;
    this.audioSinceFinal = 0;
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
          if (data.last) this.finalize();
        } else if (data.type === 'flushed') {
          this.finalize();
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
   * Ends the utterance, on button release. The worklet still holds up to one
   * chunk of audio, so ask it to flush first and only tell the provider to
   * finalize once that tail is on the wire — otherwise releasing the button can
   * clip the last word. The socket stays open for the next turn.
   */
  stop(): void {
    if (this.current === 'idle') return;
    this.turn++;
    this.stopped = true;
    this.setState('idle');
    if (!this.node) {
      this.emitTurnEnd();
      return;
    }
    this.node.port.postMessage({ type: 'flush' });
    // Safety net in case the worklet never answers; finalize anyway.
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.finalize(), 120);
  }

  /** Tell the provider this utterance is over. */
  private finalize(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    void this.teardownGraph();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'finalize' }));
    }
    // Everything heard so far is already in `partial`, so answering can start now.
    // If the provider has not confirmed the tail we flushed, give it a brief
    // window to correct our text before the caller commits to it.
    if (this.audioSinceFinal > 0) {
      if (this.finalTimer) clearTimeout(this.finalTimer);
      this.finalTimer = setTimeout(() => this.emitTurnEnd(), 150);
      return;
    }
    this.emitTurnEnd();
  }

  /** Emit the accumulated turn transcript, once. */
  private emitTurnEnd(): void {
    if (this.finalTimer) clearTimeout(this.finalTimer);
    this.finalTimer = null;
    if (!this.stopped) return;
    this.stopped = false;
    const text = [...this.segments, this.partial].map((s) => s.trim()).filter(Boolean).join(' ').trim();
    this.segments = [];
    this.partial = '';
    if (text) this.transcripts.emit({ type: 'final', text });
  }

  /** Current best text for the in-progress turn: finished segments plus partial. */
  private currentText(): string {
    return [...this.segments, this.partial].map((s) => s.trim()).filter(Boolean).join(' ');
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
    if (data.type !== 'transcript') return;

    const text = data.text.trim();
    if (data.final) {
      // An empty final is the provider acknowledging our `finalize`, not a new
      // segment; ignore it so it does not add a stray space.
      if (text) this.segments.push(text);
      this.partial = '';
      this.audioSinceFinal = 0;
      // The release has already happened and this is the segment it was waiting
      // for, so end the turn now rather than sitting on the timeout.
      if (this.stopped) {
        this.emitTurnEnd();
        return;
      }
    } else {
      this.partial = text;
    }
    // The turn is not over until the button is released, but the user should see
    // words appear as they speak, so a partial is emitted as an update — marked
    // partial so the caller does not treat it as the end of the turn.
    const current = this.currentText();
    if (current) this.transcripts.emit({ type: 'partial', text: current });
  }

  private send(pcm: Int16Array): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.audioSinceFinal += pcm.length;
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

import { Emitter } from './events.js';

export type RecorderState = 'idle' | 'starting' | 'recording';

export type FinalTranscript = { type: 'final'; text: string };
export type PartialTranscript = { type: 'partial'; text: string };
export type SttEvent = FinalTranscript | PartialTranscript;

const TARGET_SAMPLE_RATE = 16000;

/**
 * Push-to-talk microphone capture. Streams 16 kHz linear16 PCM to the server's
 * STT relay and surfaces transcript events. The AudioWorklet keeps resampling
 * off the main thread so the UI stays responsive while recording.
 */
export class Recorder {
  readonly transcripts = new Emitter<SttEvent>();
  readonly level = new Emitter<number>();
  readonly errors = new Emitter<string>();
  readonly state = new Emitter<RecorderState>();

  private socket: WebSocket | null = null;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private current: RecorderState = 'idle';

  private setState(next: RecorderState): void {
    this.current = next;
    this.state.emit(next);
  }

  get isRecording(): boolean {
    return this.current === 'recording';
  }

  async start(): Promise<void> {
    if (this.current !== 'idle') return;
    this.setState('starting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.context = new AudioContext({ latencyHint: 'interactive' });
      await this.context.audioWorklet.addModule('/pcm-worklet.js');
      await this.openSocket();

      this.source = this.context.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.context, 'pcm16-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE },
      });

      this.node.port.onmessage = (event: MessageEvent) => {
        const data = event.data as { type: string; pcm?: Int16Array; rms?: number };
        if (data.type === 'audio' && data.pcm) this.send(data.pcm);
        else if (data.type === 'level' && typeof data.rms === 'number') this.level.emit(Math.min(1, data.rms * 4.5));
      };

      this.source.connect(this.node);
      await this.context.resume();
      this.setState('recording');
    } catch (err) {
      this.errors.emit(err instanceof Error ? err.message : String(err));
      await this.teardown();
      this.setState('idle');
    }
  }

  /** Ends the utterance: flushes the STT buffer, keeps the socket for the final event. */
  stop(): void {
    if (this.current === 'idle') return;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'finalize' }));
    }
    void this.teardown();
    this.setState('idle');
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${proto}://${location.host}/api/stt`);
      this.socket = socket;
      socket.binaryType = 'arraybuffer';

      const failEarly = (): void => reject(new Error('could not reach the speech service'));
      socket.onopen = () => resolve();
      socket.onerror = failEarly;

      socket.onmessage = (event: MessageEvent) => {
        let data: { transcript?: string; is_final?: boolean; type?: string; message?: string };
        try {
          data = JSON.parse(typeof event.data === 'string' ? event.data : '');
        } catch {
          return;
        }
        if (data.type === 'error') {
          if (this.current === 'starting') reject(new Error(data.message ?? 'speech service error'));
          this.errors.emit(data.message ?? 'speech service error');
          return;
        }
        const text = (data.transcript ?? '').trim();
        if (!text) return;
        this.transcripts.emit(data.is_final ? { type: 'final', text } : { type: 'partial', text });
      };
    });
  }

  private send(pcm: Int16Array): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const view = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const copy = new Uint8Array(view.length);
    copy.set(view);
    this.socket.send(copy.buffer);
  }

  private async teardown(): Promise<void> {
    this.node?.port.close();
    this.node?.disconnect();
    this.node = null;

    this.source?.disconnect();
    this.source = null;

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;

    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
    }

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      // Give smallest.ai a moment to deliver the terminal transcript before closing.
      setTimeout(() => socket.close(), 1200);
    }

    this.level.emit(0);
  }
}

// Captures mono microphone audio, resamples it to 16 kHz linear16 PCM, and
// posts ~64 ms chunks to the main thread. Runs on the audio thread so the
// capture path never competes with rendering.

type CaptureOptions = { processorOptions?: { targetSampleRate?: number } };

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;

/** Ambient surface for the AudioWorklet global scope (not in lib.dom). */
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class PCM16Capture extends AudioWorkletProcessor {
  private targetRate: number;
  private ratio: number;
  private chunkSamples: number;

  // Resampler state, carried across process() calls.
  private tail = new Float32Array(0);
  private readPos = 0;

  // Output staging.
  private pending: Float32Array[] = [];
  private pendingLen = 0;

  // Level metering (~20 fps).
  private levelSq = 0;
  private levelCount = 0;
  private levelWindow: number;
  private levelSeen = 0;

  constructor(options: CaptureOptions) {
    super();
    this.targetRate = options?.processorOptions?.targetSampleRate ?? 16000;
    this.ratio = sampleRate / this.targetRate;
    this.chunkSamples = Math.max(1, Math.round(this.targetRate * 0.064));
    this.levelWindow = Math.round(sampleRate * 0.05);
  }

  private resample(input: Float32Array): Float32Array {
    const buf = new Float32Array(this.tail.length + input.length);
    buf.set(this.tail);
    buf.set(input, this.tail.length);

    const out: number[] = [];
    let pos = this.readPos;
    while (pos + 1 < buf.length) {
      const i0 = pos | 0;
      const frac = pos - i0;
      const a = buf[i0] ?? 0;
      const b = buf[i0 + 1] ?? a;
      out.push(a + (b - a) * frac);
      pos += this.ratio;
    }

    const consumed = Math.floor(pos);
    this.tail = buf.slice(consumed);
    this.readPos = pos - consumed;

    return Float32Array.from(out);
  }

  private take(count: number): Float32Array {
    const out = new Float32Array(count);
    let written = 0;
    while (written < count && this.pending.length) {
      const head = this.pending[0]!;
      const need = count - written;
      if (head.length <= need) {
        out.set(head, written);
        written += head.length;
        this.pending.shift();
      } else {
        out.set(head.subarray(0, need), written);
        this.pending[0] = head.subarray(need);
        written += need;
      }
    }
    this.pendingLen -= written;
    return written === count ? out : out.subarray(0, written);
  }

  private emit(chunk: Float32Array): void {
    const pcm = new Int16Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i] ?? 0));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage({ type: 'audio', pcm }, [pcm.buffer]);
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    let mono = input[0];
    if (input.length > 1) {
      const mixed = new Float32Array(mono.length);
      for (const channel of input) {
        for (let i = 0; i < channel.length; i++) {
          mixed[i] = (mixed[i] ?? 0) + (channel[i] ?? 0);
        }
      }
      for (let i = 0; i < mixed.length; i++) mixed[i] = (mixed[i] ?? 0) / input.length;
      mono = mixed;
    }

    for (let i = 0; i < mono.length; i++) this.levelSq += (mono[i] ?? 0) ** 2;
    this.levelCount += mono.length;
    this.levelSeen += mono.length;
    if (this.levelSeen >= this.levelWindow) {
      this.port.postMessage({
        type: 'level',
        rms: Math.sqrt(this.levelSq / Math.max(1, this.levelCount)),
      });
      this.levelSq = 0;
      this.levelCount = 0;
      this.levelSeen = 0;
    }

    const resampled = this.resample(mono);
    if (resampled.length) {
      this.pending.push(resampled);
      this.pendingLen += resampled.length;
    }
    while (this.pendingLen >= this.chunkSamples) this.emit(this.take(this.chunkSamples));

    return true;
  }
}

registerProcessor('pcm16-capture', PCM16Capture);

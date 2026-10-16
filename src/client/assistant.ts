import { Emitter } from './events.js';
import type { Recorder } from './recorder.js';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type AssistantEvents = {
  user: string;
  /** Streaming assistant text, appended incrementally. */
  tokens: string;
  /** A finished assistant reply (after TTS was queued). */
  reply: string;
  speaking: boolean;
  error: string;
};

/**
 * Orchestrates one conversational turn:
 *   final transcript -> Groq (streamed) -> sentence chunking -> smallest.ai TTS -> playback.
 *
 * TTS starts per sentence instead of per reply, so audio begins long before the
 * model has finished writing. A prefetch window keeps a couple of clips ready
 * ahead of the speaker so playback never starves.
 */
export class Assistant {
  user = new Emitter<string>();
  tokens = new Emitter<string>();
  reply = new Emitter<string>();
  speaking = new Emitter<boolean>();
  errors = new Emitter<string>();

  private history: ChatMessage[] = [];
  private queue: HTMLAudioElement[] = [];
  private urls: string[] = [];
  private playing = false;
  private generation = 0;
  private controller: AbortController | null = null;
  private ttsChain: Promise<void> = Promise.resolve();

  constructor(private readonly recorder: Recorder) {
    this.recorder.transcripts.on((event) => {
      if (event.type === 'final') void this.respond(event.text);
    });
  }

  get isBusy(): boolean {
    return this.controller !== null || this.playing || this.queue.length > 0;
  }

  /** Cancel the current turn: abort the model stream, drop audio, stop playback. */
  cancel(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;

    for (const audio of this.queue) {
      audio.pause();
      audio.src = '';
    }
    this.queue.length = 0;

    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.length = 0;

    this.playing = false;
    this.speaking.emit(false);
  }

  private async respond(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean) return;

    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;

    this.user.emit(clean);
    this.history.push({ role: 'user', content: clean });

    let full = '';
    let buffer = '';

    const flush = (sentence: string, final: boolean): void => {
      const chunk = sentence.trim();
      if (chunk) void this.enqueue(chunk, generation);
    };

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: this.history }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '');
        throw new Error(`model request failed (${response.status}) ${detail}`.trim());
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let sse = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        sse += decoder.decode(value, { stream: true });

        const frames = sse.split('\n\n');
        sse = frames.pop() ?? '';

        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;

          let token: string;
          try {
            token = (JSON.parse(payload) as { token?: string }).token ?? '';
          } catch {
            continue;
          }
          if (!token || generation !== this.generation) continue;

          full += token;
          buffer += token;
          this.tokens.emit(token);

          let cut = -1;
          const match = /[.!?…]\s|\n/.exec(buffer);
          if (match) cut = match.index + (match[0].startsWith('\n') ? 0 : 1);
          else if (buffer.length > 220) {
            const space = buffer.lastIndexOf(' ', 200);
            cut = space > 0 ? space : buffer.length;
          }
          if (cut > 0) {
            flush(buffer.slice(0, cut), false);
            buffer = buffer.slice(cut);
          }
        }
      }

      flush(buffer, true);
      full = full.trim();

      if (generation !== this.generation) return;

      if (full) {
        this.history.push({ role: 'assistant', content: full });
        this.trimHistory();
        this.reply.emit(full);
      }
    } catch (err) {
      if (generation === this.generation && !(err instanceof DOMException && err.name === 'AbortError')) {
        this.errors.emit(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (generation === this.generation) this.controller = null;
    }
  }

  private trimHistory(): void {
    const max = 16;
    if (this.history.length <= max) return;
    this.history = this.history.slice(-max);
  }

  /**
   * Synthesize one chunk and push it onto the playback queue. Each request fires
   * immediately (so TTS overlaps with model streaming), while a serial chain
   * appends finished clips in sentence order.
   */
  private enqueue(text: string, generation: number): void {
    const clip = this.fetchClip(text, this.controller?.signal);
    const task = this.ttsChain.then(async () => {
      const blob = await clip;
      if (!blob || generation !== this.generation) return;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.preload = 'auto';
      this.urls.push(url);
      this.queue.push(audio);
      this.hydrate();
    });
    this.ttsChain = task;
  }

  private async fetchClip(text: string, signal?: AbortSignal): Promise<Blob | null> {
    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal,
      });
      if (!response.ok) throw new Error(`voice request failed (${response.status})`);
      return await response.blob();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null;
      this.errors.emit(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /** play(), pause() or resume() every queued clip so they share one timeline. */
  private hydrate(): void {
    for (const audio of this.queue) {
      if (audio.paused) {
        audio.play().catch(() => undefined);
      }
    }
    if (!this.playing && this.queue.length) {
      this.playing = true;
      this.speaking.emit(true);
    }
  }

  /** Drop clips whose audio has already been consumed. */
  private prune(): void {
    while (this.queue.length) {
      const audio = this.queue[0];
      if (!audio) break;
      if (!audio.ended && !(audio.paused && audio.currentTime >= audio.duration)) break;

      const url = audio.src;
      this.queue.shift();
      audio.pause();
      audio.removeAttribute('src');
      for (let i = this.urls.length - 1; i >= 0; i--) {
        const candidate = this.urls[i];
        if (candidate === url) {
          URL.revokeObjectURL(candidate);
          this.urls.splice(i, 1);
        }
      }

      if (this.playing && this.queue.length === 0) {
        this.playing = false;
        this.speaking.emit(false);
      }
    }
  }

  /** Called on a timer from the page to keep the queue tidy. */
  tick(): void {
    this.prune();
  }
}

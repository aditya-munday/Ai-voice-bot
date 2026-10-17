import { Emitter } from './events.js';
import { SpeechSanitizer } from '../sanitize.js';
import { Segmenter } from '../segment.js';
import type { SpeechPlayer } from './speech.js';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type AssistantEvents = {
  user: string;
  /** Raw model tokens, in order, for the on-screen transcript. */
  tokens: string;
  /** The finished assistant reply. */
  reply: string;
  speaking: boolean;
  error: string;
};

/**
 * Orchestrates one conversational turn:
 *   final transcript -> Groq (streamed) -> sanitize -> segment -> streaming TTS.
 *
 * The reply is fed to the synthesizer as soon as each clause is complete, inside
 * one synthesis context, so audio starts while the model is still writing and
 * prosody still runs continuously across fragments.
 */
export class Assistant {
  readonly user = new Emitter<string>();
  readonly tokens = new Emitter<string>();
  readonly reply = new Emitter<string>();
  readonly speaking = new Emitter<boolean>();
  readonly errors = new Emitter<string>();

  private history: ChatMessage[] = [];
  private controller: AbortController | null = null;
  private generation = 0;
  private speakingNow = false;

  constructor(private readonly speech: SpeechPlayer) {
    this.speech.speaking.on((value) => {
      this.speakingNow = value;
      this.speaking.emit(value);
    });
    this.speech.errors.on((message) => this.errors.emit(message));
  }

  get isBusy(): boolean {
    return this.controller !== null || this.speakingNow;
  }

  /** Cancel the current turn: abort the model stream and stop all playback. */
  cancel(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.speech.cancel();
  }

  /** Answer a final transcript. Safe to call fire-and-forget. */
  async ask(text: string): Promise<void> {
    return this.respond(text);
  }

  private async respond(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean) return;

    this.cancel();
    const generation = this.generation;

    const controller = new AbortController();
    this.controller = controller;

    this.user.emit(clean);

    // The user turn is not committed to history until the reply lands, so an
    // aborted or failed turn cannot leave an unanswered user message behind.
    const outgoing: ChatMessage[] = [...this.history, { role: 'user', content: clean }];

    const sanitizer = new SpeechSanitizer();
    const segmenter = new Segmenter();
    const pending: string[] = [];
    let raw = '';
    let buffer = '';
    let started = false;

    // Open the synthesis context immediately; it is usually ready before the
    // first token, so the first clause can go straight out.
    const begin = this.speech.begin().then(
      () => {
        if (generation !== this.generation) return;
        started = true;
        for (const fragment of pending) this.speech.push(fragment);
        pending.length = 0;
      },
      (err: unknown) => {
        if (generation === this.generation) {
          this.errors.emit(err instanceof Error ? err.message : String(err));
        }
      },
    );

    /** Hand finished fragments to the synthesizer, or hold until it is ready. */
    const speak = (fragments: string[]): void => {
      for (const fragment of fragments) {
        if (started) this.speech.push(fragment);
        else pending.push(fragment);
      }
    };

    /** Pull complete fragments out of `buffer`, keeping the incomplete tail. */
    const segment = (final: boolean): void => {
      speak(segmenter[final ? 'flush' : 'push'](buffer));
      buffer = '';
    };

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: outgoing }),
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

          let parsed: { token?: string; error?: string };
          try {
            parsed = JSON.parse(payload) as { token?: string; error?: string };
          } catch {
            continue;
          }
          if (parsed.error) throw new Error(parsed.error);
          const token = parsed.token;
          if (!token || generation !== this.generation) continue;

          raw += token;
          this.tokens.emit(token);
          buffer += sanitizer.push(token);
          segment(false);
        }
      }

      buffer += sanitizer.flush();
      segment(true);

      await begin;
      if (generation !== this.generation) return;

      this.speech.finish();

      const reply = raw.trim();
      if (reply) {
        this.history = [...outgoing, { role: 'assistant', content: reply }];
        this.trimHistory();
        this.reply.emit(reply);
      }
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      if (generation !== this.generation) return;
      this.speech.cancel();
      if (!aborted) this.errors.emit(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === this.generation) this.controller = null;
    }
  }

  private trimHistory(): void {
    const max = 16;
    if (this.history.length <= max) return;
    this.history = this.history.slice(-max);
  }
}

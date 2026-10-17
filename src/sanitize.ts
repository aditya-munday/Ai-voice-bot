/**
 * Streaming speech sanitizer.
 *
 * The model is asked to emit speech-ready text, but it does not always comply:
 * it will happily emit backticks, markdown emphasis, and bare symbols. Feeding
 * those to a TTS engine produces stutters, spelled-out punctuation, or dropped
 * words. This turns the token stream into text a person would actually say,
 * incrementally, so sanitizing adds no perceptible latency.
 *
 * Design notes:
 * - Character-level state machine over the token stream, not a regex over the
 *   whole reply, so it can run as tokens arrive.
 * - Whitespace is emitted lazily: a pending space is materialized only when the
 *   next real word shows up, which collapses runs and never emits a trailing
 *   space. The `prev`/`needSpace` flags are *lifetime* state, not per-buffer
 *   state, so chunk boundaries do not lose the space between two words.
 * - A lone trailing `]` is held back: it might begin a markdown link (`](url)`),
 *   and that is the only case needing one character of lookahead.
 * - Apostrophes and sentence punctuation are preserved verbatim; everything else
 *   maps to a spoken word, a space, or nothing.
 */

/** Symbols that become a spoken word. */
const WORDS: Record<string, string> = {
  '%': 'percent',
  '&': 'and',
  '+': 'plus',
  '=': 'equals',
  '@': 'at',
  '°': 'degrees',
  '×': 'times',
  '÷': 'divided by',
  '~': 'about',
  '/': 'or',
  '\\': 'or',
  ';': ',',
  ':': ',',
  '–': ',',
  '—': ',',
  '−': ',',
  '…': '.',
  '“': '',
  '”': '',
  // Devanagari sentence terminators. Hindi transcripts end sentences with these
  // rather than a period, and passing one through as a word would hand the TTS
  // engine a bare danda to pronounce.
  '।': '.',
  '॥': '.',
};

/**
 * Hyphens that join two words. Spoken as a space so "object oriented" comes out
 * as two words; dropping the mark instead would fuse it into "objectoriented".
 * The curly single quotes are absent from WORDS on purpose: as words they would
 * be read aloud, so the APOSTROPHE rule below attaches or discards them instead.
 */
const HYPHENS = new Set(['-', '\u2010', '\u2011', '\u2012', '\u2015']);

/** Dropped outright, with no space left behind: markdown emphasis and code marks. */
const SKIP = new Set(['*', '`', '#', '|', '>', '^', '[', ']', '(', ')', '{', '}', '<', '"', '\u00ad']);

/** Sentence punctuation, kept as-is and attached to the preceding word. */
const SENTENCE = new Set(['.', ',', '?', '!', ':']);
const APOSTROPHE = new Set(["'", '’']);

/**
 * Characters that join the current word instead of starting a new one.
 *
 * Covers every script's combining marks: Devanagari vowel signs and the nukta
 * that Hindi text needs, plus Arabic and Latin diacritics. Without this, a
 * Devanagari vowel sign would be treated as an unknown symbol and dropped,
 * silently mangling the word it belongs to.
 */
const WORD_JOINER = /[\p{L}\p{M}\p{N}\u200c\u200d]/u;

export class SpeechSanitizer {
  private buffer = '';
  private acc = '';
  /** A real character has been emitted at least once. */
  private prev = false;
  /**
   * The last character handed to the output, kept across drains. `acc` is reset
   * after every drain, so it cannot answer "does an apostrophe follow a letter"
   * when the two arrive in different tokens.
   */
  private lastChar = '';
  /** A space is owed before the next word. */
  private needSpace = false;
  private inLink = false;

  /** Feed a token; returns any newly speakable text. */
  push(chunk: string): string {
    this.buffer += chunk;
    return this.drain(false);
  }

  /** End of stream; returns everything still buffered. */
  flush(): string {
    return this.drain(true);
  }

  private emitWord(text: string): void {
    if (!text) return;
    if (this.needSpace && this.prev) this.acc += ' ';
    this.needSpace = false;
    this.acc += text;
    this.prev = true;
    this.lastChar = text.slice(-1);
  }

  private emitSpace(): void {
    if (this.prev) this.needSpace = true;
  }

  private emitSentence(c: string): void {
    if (!this.prev) return;
    const last = this.acc.slice(-1);
    // Collapse repeats: "..." and "?!" read the same as one mark to a TTS engine.
    if (last && SENTENCE.has(last)) return;
    this.acc += c;
    this.prev = true;
    this.lastChar = c;
  }

  private drain(final: boolean): string {
    let i = 0;
    const n = this.buffer.length;

    while (i < n) {
      const c = this.buffer[i]!;

      if (this.inLink) {
        if (c === ')') {
          this.inLink = false;
          this.emitSpace();
        }
        i++;
        continue;
      }

      if (c === ']') {
        // `](` opens a markdown link; hold a lone `]` until we can tell.
        if (i + 1 >= n && !final) break;
        if (this.buffer[i + 1] === '(') {
          this.inLink = true;
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      if (c === '\n' || c === '\r') {
        // A newline after a sentence mark is just the line break; otherwise it
        // ends a sentence.
        const last = this.acc.slice(-1);
        if (last && !SENTENCE.has(last)) this.emitSentence('.');
        this.emitSpace();
        i++;
        continue;
      }

      if (c === '\t' || c === ' ') {
        this.emitSpace();
        i++;
        continue;
      }

      if (SKIP.has(c)) {
        i++;
        continue;
      }

      if (HYPHENS.has(c)) {
        this.emitSpace();
        i++;
        continue;
      }

      if (c === '_') {
        this.emitSpace();
        i++;
        continue;
      }

      const word = WORDS[c];
      if (word !== undefined) {
        if (word === '') {
          i++;
          continue;
        }
        // Collapse a run of the same symbol: "&&" reads as one "and".
        let j = i + 1;
        while (j < n && this.buffer[j] === c) j++;
        if (SENTENCE.has(word)) {
          this.emitSentence(word);
        } else {
          this.emitSpace();
          this.emitWord(word);
          this.emitSpace();
        }
        i = j;
        continue;
      }

      if (APOSTROPHE.has(c)) {
        // A letter can arrive in the next token, so hold a trailing apostrophe
        // until we can see what follows it, the same way a lone `]` is held.
        if (i + 1 >= n && !final) break;
        const next = this.buffer[i + 1];
        const nextIsWord = next !== undefined && /[\p{L}\p{N}]/u.test(next);
        if (/[\p{L}\p{N}]/u.test(this.lastChar) && nextIsWord) this.emitWord("'");
        i++;
        continue;
      }

      if (SENTENCE.has(c)) {
        this.emitSentence(c);
        i++;
        continue;
      }

      // A word continues with letters, digits, and combining marks, so Devanagari
      // vowel signs and accents stay attached to the word they decorate.
      if (WORD_JOINER.test(c)) {
        this.emitWord(c);
        i++;
        continue;
      }

      // Anything left is a symbol with no spoken form, such as a stray en dash or
      // an unusual quote. Drop it: a space would break a hyphenated word in two,
      // and passing it through would hand the engine a glyph to spell out.
      i++;
    }

    this.buffer = this.buffer.slice(i);
    const out = this.acc;
    this.acc = '';
    return out;
  }
}

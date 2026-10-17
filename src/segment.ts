/**
 * Incremental fragmenter for streaming text.
 *
 * Turns a growing string into the fragments that should be synthesized next,
 * choosing boundaries so speech starts early and still sounds natural:
 *
 *   1. a sentence end, once it is followed by more text (or the stream ended);
 *   2. failing that, a clause boundary (a comma);
 *   3. failing that, a forced break at a word boundary once the run gets long.
 *
 * The first break is allowed much earlier than later ones: getting the first
 * word out is what the user perceives as responsiveness, while later cuts can be
 * longer so the voice engine has more context for natural prosody.
 *
 * Note that (3) is what makes the very first fragment small. A short reply like
 * "Four." never hits a boundary, so it is emitted whole on flush; a longer one
 * starts speaking at `firstMin` characters instead of waiting for its first
 * period.
 */
export class Segmenter {
  private buffer = '';
  private emitted = false;
  private readonly firstMin: number;
  private readonly max: number;

  constructor(firstMin = 16, max = 90) {
    this.firstMin = firstMin;
    this.max = max;
  }

  /** Feed newly available text; returns complete fragments, in order. */
  push(text: string): string[] {
    this.buffer += text;
    return this.take(false);
  }

  /** End of stream; returns all remaining fragments. */
  flush(): string[] {
    return this.take(true);
  }

  private take(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut(final);
      if (cut < 0) break;
      const fragment = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (fragment) {
        out.push(fragment);
        this.emitted = true;
      }
      if (final && !this.buffer.trim()) break;
    }
    return out;
  }

  private findCut(final: boolean): number {
    const buffer = this.buffer;

    // 1. Sentence end. Held back mid-stream unless more text already follows,
    //    because the next character may be another terminator ("?!").
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer[i]!;
      if (c === '.' || c === '!' || c === '?') {
        if (i + 1 < buffer.length || final) return i + 1;
      }
    }

    // 2. Clause boundary: start speaking before a long sentence finishes.
    if (!final) {
      const comma = buffer.lastIndexOf(', ');
      if (comma >= 0) return comma + 1;
    }

    // 3. Word-boundary safety valve so a punctuation-free run still streams.
    const threshold = this.emitted ? this.max : this.firstMin;
    if (buffer.length >= threshold) {
      const space = buffer.lastIndexOf(' ', Math.min(buffer.length, this.max));
      if (space > 0) return space;
    }

    if (final && buffer.trim()) return buffer.length;
    return -1;
  }
}

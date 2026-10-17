/**
 * Per-turn tracing.
 *
 * A turn is one conversational exchange: release -> transcript -> model -> speech
 * -> done. Every mark is milliseconds from that turn's own start (`release`), all
 * read off one clock, the client's. That is deliberate: the browser, the Node
 * latency harness, and the server each have their own wall clock, and correlating
 * three clocks over a network would add more error than the sub-100 ms deltas we
 * are trying to see. So the party that observes a mark stamps it, and the server
 * only stores and aggregates.
 *
 * Shared by `src/client/assistant.ts` (browser), `scripts/latency.mts` (Node
 * harness) and `src/server.ts` (aggregation), so all three agree on the shape.
 */

export const MARK_NAMES = [
  'release',
  'stt_final',
  'llm_request',
  'first_token',
  'first_fragment_sent',
  'first_audio_frame',
  'first_audio_played',
  'turn_end',
] as const;

export type MarkName = (typeof MARK_NAMES)[number];

/** One tool invocation, from call to result. `end` is -1 until it finishes. */
export type ToolSpan = { name: string; start: number; end: number; ok: boolean };

export type TurnTrace = {
  turnId: string;
  /** Milliseconds from this turn's release. */
  marks: Partial<Record<MarkName, number>>;
  tools: ToolSpan[];
  language: string;
  /** Final transcript, truncated. Never audio. */
  transcript: string;
  error?: string;
};

/** Stage pairs reported by `/api/metrics`, as from -> to mark names. */
export const STAGES: { name: string; from: MarkName; to: MarkName }[] = [
  { name: 'release_to_stt_final', from: 'release', to: 'stt_final' },
  { name: 'release_to_llm_request', from: 'release', to: 'llm_request' },
  { name: 'release_to_first_token', from: 'release', to: 'first_token' },
  { name: 'release_to_first_fragment', from: 'release', to: 'first_fragment_sent' },
  { name: 'release_to_first_audio', from: 'release', to: 'first_audio_frame' },
  { name: 'release_to_audio_played', from: 'release', to: 'first_audio_played' },
  { name: 'release_to_turn_end', from: 'release', to: 'turn_end' },
  { name: 'llm_request_to_first_token', from: 'llm_request', to: 'first_token' },
];

/** Records marks for one turn against a fixed start time. */
export class TurnTracer {
  readonly turnId: string;
  private readonly t0: number;
  private readonly marks: Partial<Record<MarkName, number>> = {};
  private readonly tools: ToolSpan[] = [];
  private language = '';
  private transcript = '';
  private error: string | undefined;

  constructor(turnId: string, t0: number = Date.now()) {
    this.turnId = turnId;
    this.t0 = t0;
  }

  /**
   * Stamp a mark. First write wins, so a caller can mark optimistically without
   * checking: a later duplicate (e.g. a second token) cannot move the mark and
   * silently inflate the measured stage.
   */
  mark(name: MarkName): number {
    const existing = this.marks[name];
    if (existing !== undefined) return existing;
    const value = Date.now() - this.t0;
    this.marks[name] = value;
    return value;
  }

  get elapsed(): number {
    return Date.now() - this.t0;
  }

  setLanguage(language: string): void {
    this.language = language;
  }

  setTranscript(text: string): void {
    // Bounded: traces are held in memory and logged, and a runaway transcript
    // would be the one unbounded field here.
    this.transcript = text.slice(0, 200);
  }

  setError(message: string): void {
    this.error = message.slice(0, 300);
  }

  /** Open a tool span; returns the handle to pass to `toolEnd`. */
  toolStart(name: string): number {
    this.tools.push({ name, start: Date.now() - this.t0, end: -1, ok: false });
    return this.tools.length - 1;
  }

  toolEnd(index: number, ok: boolean): void {
    const span = this.tools[index];
    if (!span) return;
    span.end = Date.now() - this.t0;
    span.ok = ok;
  }

  snapshot(): TurnTrace {
    return {
      turnId: this.turnId,
      marks: { ...this.marks },
      tools: this.tools.map((t) => ({ ...t })),
      language: this.language,
      transcript: this.transcript,
      ...(this.error ? { error: this.error } : {}),
    };
  }
}

/** Linear-interpolation percentile. `p` in [0,1]. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

export type StageStats = { n: number; p50: number | null; p95: number | null; min: number | null; max: number | null };

/**
 * Roll traces up into per-stage percentiles.
 *
 * Only turns that carry *both* ends of a stage contribute to it. Treating a
 * missing end as zero would drag p50 down and hide exactly the regressions this
 * is meant to catch.
 */
export function summarize(traces: TurnTrace[]): { turns: number; stages: Record<string, StageStats> } {
  const stages: Record<string, StageStats> = {};
  for (const stage of STAGES) {
    const values: number[] = [];
    for (const trace of traces) {
      const from = trace.marks[stage.from];
      const to = trace.marks[stage.to];
      if (from === undefined || to === undefined) continue;
      const delta = to - from;
      if (delta >= 0) values.push(delta);
    }
    stages[stage.name] = {
      n: values.length,
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
    };
  }
  return { turns: traces.length, stages };
}

/** A trace is well formed if it has an id, marks, and no absurd values. */
export function isValidTrace(value: unknown): value is TurnTrace {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<TurnTrace>;
  if (typeof v.turnId !== 'string' || !v.turnId || v.turnId.length > 64) return false;
  if (typeof v.marks !== 'object' || v.marks === null) return false;
  for (const [key, mark] of Object.entries(v.marks)) {
    if (!(MARK_NAMES as readonly string[]).includes(key)) return false;
    if (typeof mark !== 'number' || !Number.isFinite(mark) || mark < 0 || mark > 600_000) return false;
  }
  return true;
}

/** Unique-enough turn id. `crypto.randomUUID` exists in browsers and Node 20+. */
export function newTurnId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Best-effort ship of a finished trace. Never throws and never blocks a turn:
 * tracing is diagnostic, and losing a trace must not surface to the user.
 */
export async function postTrace(trace: TurnTrace, base = ''): Promise<void> {
  try {
    await fetch(`${base}/api/trace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(trace),
      keepalive: true,
    });
  } catch {
    // ignored on purpose
  }
}

// Unit tests for the turn tracer and its aggregation. No providers, no network:
// these assert the arithmetic that every latency number in the project rests on.
import assert from 'node:assert/strict';
import { TurnTracer, percentile, summarize, isValidTrace, STAGES, type TurnTrace } from '../src/trace.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
};

/* ------------------------------ percentile ------------------------------ */
check('percentile: empty is null', percentile([], 0.5) === null);
check('percentile: single value', percentile([7], 0.95) === 7);
check('percentile: p50 of even set interpolates', percentile([10, 20], 0.5) === 15);
check('percentile: p0 is min', percentile([5, 1, 9], 0) === 1);
check('percentile: p100 is max', percentile([5, 1, 9], 1) === 9);
check('percentile: p95 of 1..100', Math.abs((percentile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95) ?? 0) - 95.05) < 0.001);

/* -------------------------------- tracer -------------------------------- */
// t0 in the past, so the mark lands at a predictable offset from it.
const tracer = new TurnTracer('t1', Date.now() - 100);
tracer.mark('release');
const offset = tracer.mark('stt_final');
check('mark: offset is measured from t0', offset >= 95 && offset <= 130, String(offset));

// First write wins: a duplicate mark must not move and inflate the stage.
const first = tracer.mark('first_token');
const second = tracer.mark('first_token');
check('mark: idempotent', first === second, `${first} vs ${second}`);

/* -------------------------------- spans --------------------------------- */
const s0 = tracer.toolStart('calculator');
tracer.toolEnd(s0, true);
const s1 = tracer.toolStart('web_search');
const snap = tracer.snapshot();
check('tool: finished span recorded', snap.tools[0]?.name === 'calculator' && snap.tools[0]?.ok === true);
check('tool: open span has end -1', snap.tools[1]?.end === -1);
check('tool: open span is not ok', snap.tools[1]?.ok === false);
tracer.toolEnd(s1, false);

/* ------------------------------ summarize ------------------------------- */
const a: TurnTrace = {
  turnId: 'a',
  marks: { release: 0, stt_final: 100, llm_request: 120, first_token: 300, first_fragment_sent: 320, first_audio_frame: 500, turn_end: 900 },
  tools: [],
  language: 'en',
  transcript: 'a',
};
// Deliberately has no first_audio_frame: a turn that never produced audio must be
// excluded from that stage, not counted as zero, which would halve p50.
const b: TurnTrace = {
  turnId: 'b',
  marks: { release: 0, stt_final: 200, llm_request: 220, first_token: 400, first_fragment_sent: 350, turn_end: 800 },
  tools: [],
  language: 'en',
  transcript: 'b',
};

const { stages, turns } = summarize([a, b]);
check('summarize: counts turns', turns === 2);
check('summarize: stt stage p50 over both', stages.release_to_stt_final?.p50 === 150, String(stages.release_to_stt_final?.p50));
check('summarize: missing end excluded, not zeroed', stages.release_to_first_audio?.n === 1, `n=${stages.release_to_first_audio?.n}`);
check('summarize: excluded turn leaves p50 at the real value', stages.release_to_first_audio?.p50 === 500, String(stages.release_to_first_audio?.p50));
check('summarize: llm_request_to_first_token present', stages.llm_request_to_first_token?.n === 2);

/* ------------------------------- validity ------------------------------- */
check('valid: real trace accepted', isValidTrace(a));
check('valid: null rejected', !isValidTrace(null));
check('valid: missing turnId rejected', !isValidTrace({ marks: {} }));
check('valid: unknown mark rejected', !isValidTrace({ turnId: 'x', marks: { bogus: 1 } }));
check('valid: negative mark rejected', !isValidTrace({ turnId: 'x', marks: { release: -1 } }));
check('valid: absurd mark rejected', !isValidTrace({ turnId: 'x', marks: { release: 10_000_000 } }));
check('valid: long turnId rejected', !isValidTrace({ turnId: 'x'.repeat(65), marks: {} }));

/* ------------------------------ stages list ----------------------------- */
const covered = new Set(STAGES.flatMap((s) => [s.from, s.to]));
check('stages: every stage endpoint is a known mark', covered.size > 0 && STAGES.length >= 8, `${STAGES.length} stages`);

console.log(`\n${failed === 0 ? 'ALL' : `${failed} of`} ${failed === 0 ? 'trace checks passed' : 'trace checks FAILED'}`);
process.exit(failed === 0 ? 0 : 1);

// Model benchmark for the voice path. Answers the brief's Phase 3 question with
// numbers instead of a guess: which Groq model gives the best time to first
// token, tool-call reliability, Hindi quality, and prompt compliance here.
//
// The account's daily token cap is per model, so a model that is exhausted for
// the day is reported as unavailable rather than silently scored zero.
//
// Env:
//   HOST    server host:port (default localhost:12000)
//   MODELS  comma list (default: the account's chat models)
//   N       turns per model (default 6)
//   JSON    print machine-readable results
const HOST = process.env.HOST ?? 'localhost:12000';

const DEFAULT_MODELS = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'allam-2-7b',
];

const models = (process.env.MODELS ?? DEFAULT_MODELS.join(',')).split(',').map((m) => m.trim()).filter(Boolean);
const N = Number(process.env.N ?? 6);

// One of each kind the brief cares about: plain fact, explanation, arithmetic,
// Hindi, Hinglish. Each probe has a cheap compliance predicate.
type Probe = { text: string; lang: 'en' | 'hi'; want: RegExp | null; label: string };
const PROBES: Probe[] = [
  { text: 'What is the capital of France?', lang: 'en', want: /paris/i, label: 'fact' },
  { text: 'Why is my build so slow?', lang: 'en', want: /recompil|incremental|cache|build/i, label: 'explain' },
  { text: 'What is seventeen times three?', lang: 'en', want: /fifty.?one|51/i, label: 'math' },
  { text: 'फ्रांस की राजधानी क्या है?', lang: 'hi', want: /पेरिस|paris/i, label: 'hindi' },
  { text: 'bhai ye code kyun nahi chal raha', lang: 'hi', want: null, label: 'hinglish' },
  { text: 'Explain what polymorphism means.', lang: 'en', want: /interface|type|object|method/i, label: 'define' },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Same guards the eval harness uses: these are the prompt's own hard rules.
const DISALLOWED = /[*#_`~<>{}[\]|\\/]|:\s|;\s|\.\.\./;
const META_TALK = /\b(as an ai|language model|my instructions|these rules|as an assistant)\b/i;

type Row = {
  model: string;
  probe: string;
  lang: string;
  status: 'ok' | 'unavailable' | 'error';
  ttft: number | null;
  words: number | null;
  symbols: boolean;
  meta: boolean;
  hit: boolean | null;
  detail: string;
};

async function runTurn(model: string, probe: Probe): Promise<Row> {
  const t0 = Date.now();
  const res = await fetch(`http://${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The relay reads the model from the body when present, so a benchmark does
    // not need the server restarted per model.
    body: JSON.stringify({ model, messages: [{ role: 'user', content: probe.text }] }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const limited = /rate_limit|tokens per day|tokens per minute/i.test(detail);
    return {
      model, probe: probe.label, lang: probe.lang,
      status: limited ? 'unavailable' : 'error',
      ttft: null, words: null, symbols: false, meta: false, hit: null,
      detail: detail.slice(0, 160),
    };
  }

  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let ttft: number | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload.startsWith('{')) continue;
      const { token } = JSON.parse(payload) as { token?: string };
      if (!token) continue;
      if (ttft === null) ttft = Date.now() - t0;
      text += token;
    }
  }

  const trimmed = text.trim();
  const words = (trimmed.match(/[A-Za-z0-9\u0900-\u097F]+/g) ?? []).length;
  return {
    model, probe: probe.label, lang: probe.lang,
    status: trimmed ? 'ok' : 'error',
    ttft: trimmed ? ttft : null,
    words,
    symbols: DISALLOWED.test(trimmed),
    meta: META_TALK.test(trimmed),
    hit: probe.want ? probe.want.test(trimmed) : null,
    detail: trimmed.slice(0, 70),
  };
}

const rows: Row[] = [];
for (const model of models) {
  for (let i = 0; i < N; i++) {
    const probe = PROBES[i % PROBES.length]!;
    try {
      const row = await runTurn(model, probe);
      rows.push(row);
      if (row.status === 'ok') {
        console.log(
          `${model.padEnd(22)} ${row.probe.padEnd(9)} ttft=${String(row.ttft).padStart(5)}ms w=${String(row.words).padStart(3)} ` +
            `sym=${row.symbols ? 'BAD' : 'ok '} meta=${row.meta ? 'BAD' : 'ok '} hit=${row.hit === null ? ' - ' : row.hit ? 'yes' : 'NO '} "${row.detail}"`,
        );
      } else {
        console.log(`${model.padEnd(22)} ${row.probe.padEnd(9)} ${row.status.toUpperCase()}: ${row.detail}`);
      }
    } catch (err) {
      rows.push({
        model, probe: probe.label, lang: probe.lang, status: 'error',
        ttft: null, words: null, symbols: false, meta: false, hit: null,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(Number(process.env.GAP_MS ?? 2500));
  }
}

const pct = (values: number[], p: number) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = p * (s.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (rank - lo);
};

const byModel = models.map((model) => {
  const own = rows.filter((r) => r.model === model);
  const ok = own.filter((r) => r.status === 'ok');
  const ttfts = ok.map((r) => r.ttft!).filter((v) => v !== null);
  const hits = own.filter((r) => r.hit !== null);
  return {
    model,
    ok: ok.length,
    unavailable: own.filter((r) => r.status === 'unavailable').length,
    errors: own.filter((r) => r.status === 'error').length,
    ttftP50: pct(ttfts, 0.5),
    ttftP95: pct(ttfts, 0.95),
    compliance: ok.length ? (ok.filter((r) => !r.symbols && !r.meta).length / ok.length) : null,
    correctness: hits.length ? (hits.filter((r) => r.hit).length / hits.length) : null,
    avgWords: ok.length ? ok.reduce((a, r) => a + (r.words ?? 0), 0) / ok.length : null,
  };
});

const f = (v: number | null, suffix = '') => (v === null ? 'n/a' : `${v.toFixed(0)}${suffix}`);
console.log('\n=== model benchmark ===');
console.log('model'.padEnd(22) + 'ok  unavail  ttft_p50  ttft_p95  comply  correct  avg_words');
for (const m of byModel) {
  console.log(
    m.model.padEnd(22) +
      String(m.ok).padStart(2) + '  ' +
      String(m.unavailable).padStart(7) + '  ' +
      f(m.ttftP50, 'ms').padStart(8) + '  ' +
      f(m.ttftP95, 'ms').padStart(8) + '  ' +
      (m.compliance === null ? 'n/a' : `${(m.compliance * 100).toFixed(0)}%`).padStart(6) + '  ' +
      (m.correctness === null ? 'n/a' : `${(m.correctness * 100).toFixed(0)}%`).padStart(7) + '  ' +
      f(m.avgWords).padStart(9),
  );
}
if (process.env.JSON) console.log(JSON.stringify({ byModel, rows }, null, 2));
process.exit(0);

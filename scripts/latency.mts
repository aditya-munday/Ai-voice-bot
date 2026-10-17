// End-to-end latency harness. Drives the server's /api/chat and /api/tts relay
// the way the client does, using the real SpeechSanitizer and Segmenter, and
// reports the timings that matter: first token, first fragment, first audio.
//
// It stamps the same TurnTracer marks the browser does and posts each trace to
// /api/trace, so `npm run latency` and the live page feed one set of numbers.
//
// Env:
//   HOST    server host:port (default localhost:12000)
//   LANG    en | hi  (default en) - which question set to drive
//   TURNS   total turns to run (default 30)
//   JSON    if set, print the summary as JSON instead of a table
import WebSocket from 'ws';
import { SpeechSanitizer } from '../src/sanitize.ts';
import { Segmenter } from '../src/segment.ts';
import { TurnTracer, newTurnId, postTrace, summarize, type TurnTrace } from '../src/trace.ts';

const HOST = process.env.HOST ?? 'localhost:12000';
const LANG = process.env.LANG === 'hi' ? 'hi' : 'en';
const TURNS = Number(process.env.TURNS ?? 30);

const EN = [
  'What is the capital of France?',
  'Give me one idea for a quick dinner.',
  'How do I reverse a list in Python?',
  'Tell me a fun fact about the ocean.',
  'What is seventeen times three?',
  'Why is my build so slow?',
  'What is a database index?',
  'Explain what polymorphism means.',
  'How do I center a div in CSS?',
  'What is the difference between a process and a thread?',
];

const HI = [
  'फ्रांस की राजधानी क्या है?',
  'जल्दी बनने वाली रात के खाने का एक आइडिया दो।',
  'पायथन में लिस्ट कैसे उलटी करें?',
  'समुद्र के बारे में एक मजेदार तथ्य बताओ।',
  'सत्रह गुणा तीन कितना होता है?',
  'मेरा बिल्ड इतना धीमा क्यों है?',
  'डेटाबेस इंडेक्स क्या होता है?',
  'पॉलिमॉर्फिज्म का मतलब समझाओ।',
  'सीएसएस में डिव को सेंटर कैसे करें?',
  'प्रोसेस और थ्रेड में क्या फर्क है?',
];

const questions = LANG === 'hi' ? HI : EN;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Groq's free tier caps tokens per minute, and this prompt is large, so a burst
 * of turns is mostly 429s. A 429 is not a latency measurement: recording one as a
 * turn produces a suspiciously fast "success" with no tokens, which is how a
 * broken baseline gets mistaken for a good one. So a rate-limited attempt is
 * retried after the delay the provider asks for, and the turn is only recorded
 * once it really produced tokens. Failures are counted, never averaged in.
 */
async function chatOnce(question: string, signal: AbortSignal): Promise<Response> {
  return fetch(`http://${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
    signal,
  });
}

/** Sleep the provider's requested retry delay, parsed from its 429 body. */
function retryDelayMs(detail: string): number {
  const match = /try again in ([\d.]+)\s*(ms|s)/i.exec(detail);
  if (!match) return 2000;
  const value = Number(match[1]);
  return match[2]!.toLowerCase() === 's' ? value * 1000 : value;
}

async function measure(
  question: string,
): Promise<{ tracer: TurnTracer; text: string; fragments: number; audioSeconds: number; attempts: number }> {
  const t0 = Date.now();
  const tracer = new TurnTracer(newTurnId(), t0);
  tracer.mark('release');
  tracer.mark('stt_final');
  tracer.setLanguage(LANG);
  tracer.setTranscript(question);

  const tts = new WebSocket(`ws://${HOST}/api/tts`);
  let sampleRate = 24000;
  let audioBytes = 0;
  let sawAudio = false;
  let ended = false;
  tts.on('message', (raw, isBinary) => {
    if (isBinary) {
      if (!sawAudio) {
        sawAudio = true;
        tracer.mark('first_audio_frame');
      }
      audioBytes += raw.length;
      return;
    }
    const m = JSON.parse(raw.toString());
    if (m.type === 'tts_ready') sampleRate = m.sampleRate;
    if (m.type === 'tts_error') console.log('   [tts_error]', m.message);
    if (m.type === 'tts_end') ended = true;
  });
  await new Promise((r) => tts.on('open', r));
  tts.send(JSON.stringify({ type: 'tts_start', sampleRate: 0 }));

  const sanitizer = new SpeechSanitizer();
  const segmenter = new Segmenter();

  const emit = (fragment: string): void => {
    tracer.mark('first_fragment_sent');
    fragments++;
    tts.send(JSON.stringify({ type: 'tts_text', text: fragment }));
  };

  let fragments = 0;
  let text = '';
  let attempts = 0;

  for (;;) {
    attempts++;
    const controller = new AbortController();
    tracer.mark('llm_request');
    let res: Response;
    try {
      res = await chatOnce(question, controller.signal);
    } catch (err) {
      throw new Error(`chat request failed: ${String(err)}`);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (res.status === 429 || detail.includes('rate_limit_exceeded')) {
        const wait = retryDelayMs(detail) + 250;
        process.stdout.write(`\r   [429] waiting ${wait.toFixed(0)}ms then retrying (attempt ${attempts})   `);
        await sleep(wait);
        continue;
      }
      throw new Error(`chat ${res.status}: ${detail.slice(0, 200)}`);
    }

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
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
        tracer.mark('first_token');
        text += token;
        for (const fragment of segmenter.push(sanitizer.push(token))) emit(fragment);
      }
    }
    if (text.trim()) break;
    // A 200 with no tokens is a silent failure, not a fast turn.
    process.stdout.write(`\r   [empty] retrying (attempt ${attempts})   `);
    await sleep(1000);
  }

  for (const fragment of segmenter.flush()) emit(fragment);
  tts.send(JSON.stringify({ type: 'tts_finish' }));

  // The terminal frame can trail the last audio frame by seconds; allow generously.
  for (let i = 0; i < 200 && !ended; i++) await sleep(50);
  tts.close();
  tracer.mark('turn_end');

  return { tracer, text: text.trim(), fragments, audioSeconds: audioBytes / 2 / sampleRate, attempts };
}

const traces: TurnTrace[] = [];
const rows: string[] = [];
let failures = 0;
for (let i = 0; i < TURNS; i++) {
  const question = questions[i % questions.length]!;
  try {
    const { tracer, text, fragments, audioSeconds, attempts } = await measure(question);
    const trace = tracer.snapshot();
    traces.push(trace);
    void postTrace(trace, `http://${HOST}`);
    const m = trace.marks;
    rows.push(
      `"${text.slice(0, 52)}"\n   TTFT ${m.first_token}ms | first-fragment ${m.first_fragment_sent}ms | first-audio ${m.first_audio_frame}ms | ${fragments} frags, ${audioSeconds.toFixed(2)}s audio${attempts > 1 ? ` (${attempts} attempts)` : ''}`,
    );
  } catch (err) {
    failures++;
    rows.push(`"${question}"\n   FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Pace below the token-per-minute cap so the next turn is not a guaranteed 429.
  await sleep(Number(process.env.GAP_MS ?? 1500));
}

const { stages } = summarize(traces);
const fmt = (v: number | null) => (v === null ? 'n/a' : `${v.toFixed(0)}ms`);

if (process.env.JSON) {
  console.log(JSON.stringify({ lang: LANG, turns: traces.length, failures, stages }, null, 2));
} else {
  for (const row of rows) console.log(row);
  console.log(`\n=== ${LANG.toUpperCase()} over ${traces.length} turns (${failures} failed) ===`);
  for (const [name, s] of Object.entries(stages)) {
    if (s.n === 0) continue;
    console.log(
      `${name.padEnd(28)} n=${String(s.n).padStart(3)}  p50 ${fmt(s.p50).padStart(7)}  p95 ${fmt(s.p95).padStart(7)}  min ${fmt(s.min)}  max ${fmt(s.max)}`,
    );
  }
  if (failures) console.log(`\nNOTE: ${failures} turn(s) failed and were excluded from the percentiles.`);
}
process.exit(0);

// Measures the provider's tail loss: how often the last word of an utterance is
// dropped when the audio stops dead on it, and how much trailing silence
// recovers it. Run the server first, then:
//
//   TAIL=0   node scripts/probe-stt-tail.mjs
//   TAIL=420 node scripts/probe-stt-tail.mjs
//
// This is why `recorder.ts` pads silence before finalizing, and why
// `scripts/smoke.mjs` does the same. PACE is the gap between 128ms audio chunks;
// the default is roughly real time, which is what the browser feeds.
import WebSocket from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';

const HOST = process.env.HOST ?? '127.0.0.1:12000';
const PHRASE = process.env.PHRASE ?? 'what is two plus two';
const TAIL_MS = Number(process.env.TAIL ?? 420);
const PACE_MS = Number(process.env.PACE ?? 130);
const RUNS = Number(process.env.RUNS ?? 8);

/** Synthesize speech with smallest.ai, for feeding back into STT. */
function synthesize(text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://api.smallest.ai/waves/v1/tts/live', {
      headers: { authorization: `Bearer ${process.env.SMALLEST_API_KEY}` },
    });
    const parts = [];
    const timeout = setTimeout(() => reject(new Error('tts synth timeout')), 15000);
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          text,
          voice_id: 'meher',
          model: 'lightning_v3.1_pro',
          language: 'en',
          sample_rate: 16000,
          complete_backoff_ms: 0,
        }),
      ),
    );
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.status === 'chunk' && m.data?.audio) parts.push(Buffer.from(m.data.audio, 'base64'));
      if (m.status === 'complete') {
        clearTimeout(timeout);
        ws.close();
        resolve(Buffer.concat(parts));
      }
    });
    ws.on('error', reject);
  });
}

async function trial(speech) {
  const ws = new WebSocket(`ws://${HOST}/api/stt`);
  const finals = [];
  let ready = false;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'ready') ready = true;
    if (m.type === 'transcript' && m.final) finals.push(m.text);
  });
  await new Promise((r) => ws.on('open', r));
  for (let i = 0; i < 100 && !ready; i++) await sleep(50);

  for (let i = 0; i < speech.length; i += 4096) {
    ws.send(speech.subarray(i, i + 4096));
    await sleep(PACE_MS);
  }
  ws.send(Buffer.alloc(Math.round(16000 * 2 * (TAIL_MS / 1000))));
  ws.send(JSON.stringify({ type: 'finalize' }));
  // The provider may split the phrase across several finals, so wait for the
  // flush rather than taking the first one.
  await sleep(4000);
  ws.close();
  return finals.join(' ');
}

const speech = await synthesize(PHRASE);
const heard = [];
for (let i = 0; i < RUNS; i++) heard.push(await trial(speech));

// The phrase is intact when it ends on the last word spoken. The recognizer may
// render a number as a numeral or spell it out, so accept both.
const words = PHRASE.trim().split(/\s+/);
const lastWord = words.pop().replace(/[^a-z0-9]/gi, '');
const lastPart = words.pop().replace(/[^a-z0-9]/gi, '');
const endings = [lastWord, lastWord === 'two' ? '2' : null].filter(Boolean);
const whole = heard.filter((t) =>
  new RegExp(`${lastPart}\\s+(${endings.join('|')})\\s*[?.!]?$`, 'i').test(t.trim()),
).length;
console.log(`tail=${TAIL_MS}ms pace=${PACE_MS}ms: whole ${whole}/${RUNS}`);
for (const t of heard) console.log(`  ${JSON.stringify(t)}`);
process.exit(whole === RUNS ? 0 : 1);

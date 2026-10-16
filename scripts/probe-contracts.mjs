// Probe the two provider contracts we depend on. Not part of the suite.
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';

const KEY = process.env.SMALLEST_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --- 1. TTS: when do `complete` frames arrive with a slow, spaced stream? --- */
async function probeTts() {
  const url = new URL('wss://api.smallest.ai/waves/v1/tts/live');
  url.searchParams.set('timeout', '180');
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${KEY}` } });
  const base = { voice_id: 'meher', model: 'lightning_v3.1_pro', language: 'en', sample_rate: 24000 };
  const ctx = 'probe-2';
  const t0 = Date.now();
  let chunks = 0;

  await new Promise((r) => ws.on('open', r));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.status === 'chunk') { chunks += 1; return; }
    console.log(`  [${String(Date.now() - t0).padStart(5)}ms] ${m.status}${m.message ? ' ' + m.message : ''}`);
  });

  const frags = [
    'The ocean covers about seventy percent of the planet.',
    'It holds most of the water on Earth.',
    'Its currents drive weather everywhere.',
    'That is why it matters so much.',
  ];
  for (const text of frags) {
    console.log(`  [${String(Date.now() - t0).padStart(5)}ms] -> send fragment`);
    ws.send(JSON.stringify({ ...base, text, context_id: ctx, continue: true, complete_backoff_ms: 0, max_buffer_delay_ms: 250 }));
    await sleep(1800);
  }
  console.log(`  [${String(Date.now() - t0).padStart(5)}ms] -> context_close`);
  ws.send(JSON.stringify({ ...base, context_id: ctx, context_close: true }));
  await sleep(9000);
  console.log('  total audio frames:', chunks);
  ws.close();
}

/* --- 2. STT: latency to a final, framed at 4096 bytes like the docs. --- */
async function probeStt(wavPath) {
  const url = new URL('wss://api.smallest.ai/waves/v1/stt/live');
  url.searchParams.set('model', 'pulse');
  url.searchParams.set('language', 'en');
  url.searchParams.set('sample_rate', '16000');
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('itn_normalize', 'true');
  url.searchParams.set('vad_events', 'true');
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${KEY}` } });
  const pcm = readFileSync(wavPath).subarray(44);
  const t0 = Date.now();
  let firstPartial = null;
  let finalAt = null;

  await new Promise((r) => ws.on('open', r));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const at = Date.now() - t0;
    if (typeof m.transcript === 'string') {
      if (!m.is_final && firstPartial === null) firstPartial = at;
      if (m.is_final) finalAt = at;
      console.log(`  [${String(at).padStart(5)}ms] ${m.is_final ? 'FINAL  ' : 'partial'} ${JSON.stringify(m.transcript)}`);
    } else if (m.type) {
      console.log(`  [${String(at).padStart(5)}ms] event ${m.type} ${JSON.stringify(m).slice(0, 120)}`);
    }
  });

  const CHUNK = 4096;
  for (let i = 0; i < pcm.length; i += CHUNK) {
    ws.send(pcm.subarray(i, i + CHUNK));
    await sleep(128);
  }
  const sentAt = Date.now() - t0;
  console.log(`  last audio frame sent at ${sentAt}ms`);

  const finAt = Date.now() - t0;
  ws.send(JSON.stringify({ type: 'finalize' }));
  await sleep(4000);
  console.log(`  finalize sent at ${finAt}ms`);
  console.log(`  first partial at ${firstPartial}ms | final at ${finalAt}ms`);
  console.log(`  final lag after finalize: ${finalAt === null ? 'NEVER' : finalAt - finAt}ms`);
  ws.close();
}

console.log('=== TTS: spaced fragments, when is `complete`? ===');
await probeTts();
const wav = process.argv[2];
if (wav) {
  console.log('\n=== STT: 4096-byte framing, finalize ===');
  await probeStt(wav);
}

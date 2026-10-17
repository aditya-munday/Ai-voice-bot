// End-to-end smoke test for the running server. Exercises all three legs the
// browser uses: the TTS relay, the Groq chat stream, and the STT relay (fed with
// synthesized speech). Run the server first, then: node scripts/smoke.mjs
import WebSocket from 'ws';

const HOST = process.env.HOST ?? 'localhost:12000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Synthesize speech with smallest.ai, for feeding back into STT. */
function synthesize(text, language = 'en') {
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
          language,
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
      if (m.status === 'error') {
        clearTimeout(timeout);
        reject(new Error(m.message ?? 'synth failed'));
      }
    });
    ws.on('error', reject);
  });
}

/* ---- 1. TTS relay: text in, PCM frames out ---- */
async function testTts() {
  const ws = new WebSocket(`ws://${HOST}/api/tts`);
  let frames = 0;
  let bytes = 0;
  let ready = false;
  let ended = false;
  let error = null;
  let lastFrames = 0;
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      frames++;
      bytes += raw.length;
      return;
    }
    const m = JSON.parse(raw.toString());
    if (m.type === 'tts_ready') ready = true;
    if (m.type === 'tts_end') ended = true;
    if (m.type === 'tts_error') error = m.message;
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'tts_start', sampleRate: 0 }));
  ws.send(JSON.stringify({ type: 'tts_text', text: 'The quick brown fox jumps over the lazy dog.' }));
  ws.send(JSON.stringify({ type: 'tts_finish' }));
  // `tts_end` only means the context was closed; audio frames can still be in
  // flight, so wait for the frames themselves to stop arriving.
  for (let i = 0; i < 100; i++) {
    if (ended && frames > 0) {
      await sleep(400);
      if (frames === lastFrames) break;
      lastFrames = frames;
    }
    await sleep(100);
  }
  ws.close();
  check('tts: ready handshake', ready);
  check('tts: audio frames', frames > 0 && bytes > 1000, `${frames} frames, ${bytes} bytes`);
  check('tts: no error', !error, error ?? '');
}

/* ---- 2. Chat stream: tokens over SSE ---- */

/** Send one user message to the chat endpoint and return the streamed reply. */
async function chat(content) {
  const res = await fetch(`http://${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content }] }),
  });
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter((p) => p.startsWith('{'))
    .map((p) => JSON.parse(p).token ?? '')
    .join('')
    .trim();
}

async function testChat() {
  const tokens = await chat('Reply with exactly one word: ready');
  check('chat: streamed reply', tokens.length > 0, JSON.stringify(tokens));

  // The whole multilingual feature rests on the model answering in the language
  // it was asked in, so assert that rather than just "some text came back".
  const hindi = await chat('मुझे बताओ कि server क्यों शुरू नहीं हो रहा');
  const devanagari = (hindi.match(/[\u0900-\u097F]/g) ?? []).length;
  check(
    'chat: answers in hindi',
    devanagari > 10,
    `${devanagari} devanagari chars, ${JSON.stringify(hindi.slice(0, 70))}`,
  );
}

/* ---- 3. STT relay: speech in, transcript out ---- */

/**
 * Speak `phrase` into the STT relay and return the final transcript.
 *
 * The relay runs with language=hi, which is the superset setting: it transcribes
 * English and Hindi alike, so both languages exercise the same code path the
 * browser uses.
 */
async function transcribe(phrase, language) {
  const ws = new WebSocket(`ws://${HOST}/api/stt`);
  const finals = [];
  let ready = false;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'ready') ready = true;
    if (m.type === 'transcript' && m.final) finals.push({ text: m.text, at: Date.now() });
  });
  await new Promise((r) => ws.on('open', r));
  for (let i = 0; i < 100 && !ready; i++) await sleep(50);

  const pcm = await synthesize(phrase, language);
  // Pace the audio roughly in real time so the VAD sees natural speech.
  for (let i = 0; i < pcm.length; i += 4096) {
    ws.send(pcm.subarray(i, i + 4096));
    await sleep(55);
  }
  const finalizeAt = Date.now();
  // The provider drops the last word if the audio stops dead on it, so end the
  // utterance with trailing silence the way a real microphone does. Measured:
  // no silence loses the tail in ~25% of runs, 400ms recovers it every time.
  ws.send(Buffer.alloc(16000 * 2 * 0.42));
  ws.send(JSON.stringify({ type: 'finalize' }));
  // The provider closes a segment on any pause, so a phrase can arrive as several
  // finals and the last one is not necessarily the first to land. Wait for the
  // flush that `finalize` triggers, or for a quiet gap if the provider had
  // already ended the utterance by itself; stopping at the first final loses the
  // word after a pause.
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const last = finals[finals.length - 1];
    if (last && last.at >= finalizeAt) break;
    if (last && Date.now() - last.at > 800) break;
  }
  ws.close();
  return { ready, transcript: finals.map((f) => f.text).join(' ').trim() };
}

async function testStt() {
  const english = await transcribe('what is two plus two', 'en');
  check('stt: ready handshake', english.ready);
  // STT may render the numerals ("2 plus 2") or spell them out; both are correct.
  check(
    'stt: transcribed speech',
    /what is (two|2) plus (two|2)/i.test(english.transcript),
    JSON.stringify(english.transcript),
  );

  // The same session setting has to handle Hindi, since the language is fixed at
  // connect time and cannot switch per turn. The script is either Devanagari or
  // Roman, so accept either spelling of the keywords.
  const hindi = await transcribe('सर्वर क्यों शुरू नहीं हो रहा है', 'hi');
  check(
    'stt: transcribed hindi speech',
    /(सर्वर|server)/i.test(hindi.transcript) && /(क्यों|kyon|kyu)/i.test(hindi.transcript),
    JSON.stringify(hindi.transcript),
  );
}

await testTts();
await testChat();
await testStt();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

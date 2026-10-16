// End-to-end latency harness. Drives the server's /api/chat and /api/tts relay
// the way the client does, using the real SpeechSanitizer and Segmenter, and
// reports the timings that matter: first token, first fragment, first audio.
import WebSocket from 'ws';
import { SpeechSanitizer } from '../src/sanitize.ts';
import { Segmenter } from '../src/segment.ts';

const HOST = process.env.HOST ?? 'localhost:12000';
const questions = [
  'What is the capital of France?',
  'Give me one idea for a quick dinner.',
  'How do I reverse a list in Python?',
  'Tell me a fun fact about the ocean.',
  'What is seventeen times three?',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measure(question) {
  const t0 = Date.now();
  const marks = { token: null, fragment: null, audio: null, end: null };

  // TTS relay socket, opened up front like the real client.
  const tts = new WebSocket(`ws://${HOST}/api/tts`);
  let sampleRate = 24000;
  let audioFrames = 0;
  let audioBytes = 0;
  tts.on('message', (raw, isBinary) => {
    if (isBinary) {
      if (marks.audio === null) marks.audio = Date.now() - t0;
      audioFrames++; audioBytes += raw.length;
      return;
    }
    const m = JSON.parse(raw.toString());
    if (m.type === 'tts_ready') sampleRate = m.sampleRate;
    if (m.type === 'tts_error') console.log('   [tts_error]', m.message);
    if (m.type === 'tts_end') marks.end = Date.now() - t0;
  });
  await new Promise((r) => tts.on('open', r));
  tts.send(JSON.stringify({ type: 'tts_start', sampleRate: 0 }));

  const sanitizer = new SpeechSanitizer();
  const segmenter = new Segmenter();

  const res = await fetch(`http://${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let fragments = 0;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split('\n\n'); buf = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload.startsWith('{')) continue;
      const { token } = JSON.parse(payload);
      if (!token) continue;
      if (marks.token === null) marks.token = Date.now() - t0;
      text += token;
      for (const fragment of segmenter.push(sanitizer.push(token))) {
        if (marks.fragment === null) marks.fragment = Date.now() - t0;
        fragments++;
        tts.send(JSON.stringify({ type: 'tts_text', text: fragment }));
      }
    }
  }
  for (const fragment of segmenter.flush()) {
    if (marks.fragment === null) marks.fragment = Date.now() - t0;
    fragments++;
    tts.send(JSON.stringify({ type: 'tts_text', text: fragment }));
  }
  tts.send(JSON.stringify({ type: 'tts_finish' }));

  // Wait for the final audio frame.
  for (let i = 0; i < 60 && marks.end === null; i++) await sleep(50);
  tts.close();

  return { question, marks, text: text.trim(), fragments, sampleRate, audioSeconds: audioBytes / 2 / sampleRate };
}

const rows = [];
for (const q of questions) {
  const r = await measure(q);
  rows.push(r);
  console.log(
    `"${r.text}"\n   TTFT ${r.marks.token}ms | first-fragment ${r.marks.fragment}ms | first-audio ${r.marks.audio}ms | complete ${r.marks.end}ms | ${r.fragments} frags, ${r.audioSeconds.toFixed(2)}s audio`,
  );
  await sleep(300);
}

const num = (v) => (v === null ? NaN : v);
const avg = (f) => (rows.map(f).reduce((a, b) => a + b, 0) / rows.length).toFixed(0);
console.log(`\nAVG: TTFT ${avg((r) => num(r.marks.token))}ms | first-fragment ${avg((r) => num(r.marks.fragment))}ms | first-audio ${avg((r) => num(r.marks.audio))}ms`);
process.exit(0);

// Where does a turn's time actually go? Drives the real page in headless
// Chromium and times each stage relative to button release.
//
//   node scripts/latency-e2e.mjs [phrase]
//
// The page records its own marks in `window.__lastTurn` (see e2e-browser.mjs);
// this script just prints them.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const PHRASE = process.env.PHRASE ?? process.argv[2] ?? 'what is the capital of France';
const WAV = process.env.WAV ?? '/tmp/e2e-speech-7742.wav';
const PAGE = process.env.PAGE ?? 'http://localhost:12000/';
const PORT = Number(process.env.CDP_PORT ?? 9334);
const HOST = process.env.HOST ?? 'localhost:12000';

if (!existsSync(WAV)) {
  console.error(`need a 16 kHz WAV fixture at ${WAV}; run scripts/e2e-browser.mjs once`);
  process.exit(1);
}
const wavB64 = readFileSync(WAV).toString('base64');

const chrome = spawn('chromium', [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox',
  '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(250);
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch {}
}
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let nextId = 1;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) =>
  new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');

// A fake mic, plus taps on both sockets so the client-side leg is measured too.
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    let source = null;
    window.__wavB64 = ${JSON.stringify(wavB64)};
    window.__playMic = async () => {
      const bytes = Uint8Array.from(atob(window.__wavB64), (c) => c.charCodeAt(0));
      const buffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
      if (source) { try { source.stop(); } catch {} }
      source = ctx.createBufferSource();
      source.buffer = buffer; source.connect(dest); source.start();
    };
    const real = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      if (!c?.audio) return real(c);
      await ctx.resume();
      return dest.stream;
    };
    window.__marks = [];
    const mark = (name) => window.__marks.push({ name, t: performance.now() });
    window.__mark = mark;

    // Time the two hops that sit between the transcript and the first audio:
    // the chat request and the first streamed token.
    const origFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/api/chat')) mark('chat-call');
      const res = await origFetch(input, init);
      if (url.includes('/api/chat')) {
        mark('chat-headers');
        try {
          const reader = res.clone().body.getReader();
          const dec = new TextDecoder();
          let seen = false;
          (async () => {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              if (!seen && dec.decode(value, { stream: true }).includes('"token"')) {
                seen = true;
                mark('first-token');
              }
            }
          })();
        } catch {}
      }
      return res;
    };
    const sendFn = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        if (this.url.includes('/api/stt') && typeof data === 'string' && data.includes('finalize')) mark('finalize-sent');
        if (this.url.includes('/api/tts') && typeof data === 'string' && data.includes('tts_text')) mark('first-tts-text');
      } catch {}
      return sendFn.call(this, data);
    };
    const OrigWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      const sock = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
      if (String(url).includes('/api/tts')) {
        sock.addEventListener('message', (ev) => {
          if (typeof ev.data === 'string') return;
          mark(window.__ttsFirst ? 'audio-frame' : 'first-audio-frame');
          window.__ttsFirst = true;
        });
      }
      if (String(url).includes('/api/stt')) {
        sock.addEventListener('message', (ev) => {
          if (typeof ev.data !== 'string') return;
          if (ev.data.includes('"final":true')) mark('stt-final');
          else if (ev.data.includes('"transcript"')) mark('stt-partial');
        });
      }
      return sock;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    Object.assign(window.WebSocket, OrigWS);
  })();`,
});

await send('Page.navigate', { url: PAGE });
await sleep(2500);

const result = await evaluate(`(async () => {
  const el = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const talk = el('#talk');
  const status = el('#status');
  const press = (type) => talk.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
  }));

  window.__ttsFirst = false;
  window.__marks = [];
  const mark = window.__mark;
  const marks = { partial: null, final: null, thinking: null, firstToken: null, speaking: null };
  let releasedAt = null;
  const poll = setInterval(() => {
    const st = status.textContent;
    if (marks.thinking === null && st.includes('Thinking')) marks.thinking = performance.now();
    if (marks.speaking === null && st.includes('Speaking')) marks.speaking = performance.now();
  }, 5);

  press('pointerdown');
  for (let i = 0; i < 100 && talk.dataset.state !== 'recording'; i++) await sleep(20);
  await window.__playMic();
  await sleep(3800);
  releasedAt = performance.now();
  press('pointerup');

  const deadline = Date.now() + 25000;
  let last = ''; let stable = Date.now();
  while (Date.now() < deadline) {
    const a = el('#answer').textContent.trim();
    if (a !== last) { last = a; stable = Date.now(); }
    else if (a && Date.now() - stable > 1500 && status.textContent.includes('Ready')) break;
    await sleep(100);
  }
  clearInterval(poll);
  const rel = (t) => (t === null ? null : Math.round(t - releasedAt));
  return {
    transcript: el('#transcript').textContent.trim(),
    answer: el('#answer').textContent.trim(),
    status: status.textContent,
    timing: {
      thinking: rel(marks.thinking),
      firstToken: rel(marks.firstToken),
      speaking: rel(marks.speaking),
    },
    client: window.__marks.map((m) => ({ name: m.name, at: Math.round(m.t - releasedAt) })),
  };
})()`);

console.log('transcript:', JSON.stringify(result.transcript));
console.log('answer:    ', JSON.stringify(result.answer));
console.log('status:    ', result.status);
console.log('UI timing (ms after release):', JSON.stringify(result.timing));
console.log('client marks:');
for (const m of result.client) console.log(`  ${String(m.at).padStart(6)}  ${m.name}`);
cleanup();
process.exit(0);

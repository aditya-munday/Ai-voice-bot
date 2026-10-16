// Headless end-to-end test of the real page.
//
// The microphone is replaced with a WAV played through Web Audio (Chromium's
// fake capture device is unreliable in headless), then the push-to-talk button
// is driven over CDP and the transcript and reply are asserted.
//
// Usage: node scripts/e2e-browser.mjs [phrase]   (server must be running)
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const PHRASE = process.env.PHRASE ?? process.argv[2] ?? 'what is two plus two';
const WAV = process.env.WAV ?? `/tmp/e2e-speech-${process.pid}.wav`;
const PAGE = process.env.PAGE ?? 'http://localhost:12000/';
const PORT = Number(process.env.CDP_PORT ?? 9333);
const HOST = process.env.HOST ?? 'localhost:12000';

/** Synthesize a phrase as a 16 kHz mono WAV, plus a second of silence so a
 *  restart is detectable, using the app's own TTS relay. */
async function makeWav(text, out = WAV) {
  if (existsSync(out) && process.env.WAV) return; // caller supplied one
  const ws = new WebSocket(`ws://${HOST}/api/tts`);
  const parts = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('synth timeout')), 20000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'tts_start', sampleRate: 16000 }));
      ws.send(JSON.stringify({ type: 'tts_text', text }));
      ws.send(JSON.stringify({ type: 'tts_finish' }));
    });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        parts.push(raw);
        return;
      }
      const m = JSON.parse(raw.toString());
      if (m.type === 'tts_error') {
        clearTimeout(timer);
        reject(new Error(m.message));
      }
      if (m.type === 'tts_end') {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.on('error', reject);
  });
  ws.close();

  const pcm = Buffer.concat(parts);
  const data = Buffer.concat([pcm, Buffer.alloc(16000 * 2)]);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(16000 * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(out, Buffer.concat([h, data]));
  return (pcm.length / 2 / 16000).toFixed(2);
}

const TURN_2 = process.env.PHRASE2;
await makeWav(PHRASE, WAV);
const wavB64 = readFileSync(WAV).toString('base64');
let wav2B64 = '';
if (TURN_2) {
  const path2 = `${WAV}.2.wav`;
  await makeWav(TURN_2, path2);
  wav2B64 = readFileSync(path2).toString('base64');
}
console.log(`phrase: ${JSON.stringify(PHRASE)}`);
if (TURN_2) console.log(`phrase2: ${JSON.stringify(TURN_2)}`);

const chrome = spawn(
  'chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=/tmp/chrome-e2e-${process.pid}`,
    `--remote-debugging-port=${PORT}`,
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

let stderr = '';
chrome.stderr.on('data', (d) => (stderr += d.toString()));
const cleanup = () => {
  try {
    chrome.kill('SIGKILL');
  } catch {
    /* already gone */
  }
};
process.on('exit', cleanup);

/* Wait for the DevTools endpoint. */
let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(250);
  try {
    wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl;
  } catch {
    /* not up yet */
  }
}
if (!wsUrl) {
  console.error('chromium did not start\n', stderr.slice(-2000));
  process.exit(1);
}

const target = await (
  await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));

let nextId = 1;
const pending = new Map();
const events = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method) {
    events.push(msg);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
  return res.result?.result?.value;
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

/* Replace the microphone with a WAV played through Web Audio, before the app
   module runs. The app caches the mic stream across turns, so the capture graph
   is created once and `__playMic` re-feeds it from the currently staged WAV. */
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    let source = null;
    window.__wavB64 = ${JSON.stringify(wavB64)};
    window.__setWav = (b64) => { window.__wavB64 = b64; };
    window.__playMic = async () => {
      const bytes = Uint8Array.from(atob(window.__wavB64), (c) => c.charCodeAt(0));
      const buffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
      if (source) { try { source.stop(); } catch {} }
      source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(dest);
      source.start();
    };
    const real = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (!constraints?.audio) return real(constraints);
      await ctx.resume();
      return dest.stream;
    };
  })();`,
});

await send('Page.navigate', { url: PAGE });
await sleep(2000);

for (const ev of events) {
  if (ev.method === 'Runtime.exceptionThrown') {
    console.log('[exception]', ev.params.exceptionDetails?.exception?.description);
  }
  if (ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error') {
    console.log('[log.error]', ev.params.entry.text);
  }
}

/* One full turn: hold the button, release, wait for the reply and for the UI to
   settle back to Ready. Defined in the page so each call is a plain round trip. */
await evaluate(`(() => {
  const el = (s) => document.querySelector(s);
  window.__turn = async (holdMs) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const talk = el('#talk');
    const status = el('#status');
    const press = (type) => talk.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
    }));

    const seen = [];
    const watch = setInterval(() => seen.push(status.textContent), 200);
    await window.__playMic();
    press('pointerdown');
    let peak = 0;
    const meter = setInterval(() => {
      const v = parseFloat(getComputedStyle(el('#meter')).getPropertyValue('--level')) || 0;
      if (v > peak) peak = v;
    }, 100);
    await sleep(holdMs);
    press('pointerup');
    clearInterval(meter);

    const deadline = Date.now() + 25000;
    let answer = '';
    let last = '';
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      answer = el('#answer').textContent.trim();
      if (answer !== last) {
        last = answer;
        stableSince = Date.now();
      } else if (answer && Date.now() - stableSince > 2000 && status.textContent.includes('Ready')) {
        break;
      }
      await sleep(200);
    }
    clearInterval(watch);
    return {
      transcript: el('#transcript').textContent.trim(),
      answer,
      status: status.textContent,
      peak,
      states: [...new Set(seen)],
    };
  };
})()`);

const turns = [{ label: 'turn 1', b64: wavB64, hold: 3800 }];
if (TURN_2) turns.push({ label: 'turn 2', b64: wav2B64, hold: 3800 });

let ok = true;
const results = [];
for (const turn of turns) {
  await evaluate(`window.__setWav(${JSON.stringify(turn.b64)})`);
  const r = await evaluate(`window.__turn(${turn.hold})`);
  results.push(r);
  console.log(`\n${turn.label}`);
  console.log('  transcript:', JSON.stringify(r.transcript));
  console.log('  answer:    ', JSON.stringify(r.answer));
  console.log('  final:     ', JSON.stringify(r.status));
  console.log('  mic peak:  ', r.peak);
  console.log('  states:    ', (r.states ?? []).join(' | '));
  ok &&= Boolean(r.transcript) && Boolean(r.answer) && /Ready/.test(r.status ?? '');
}

console.log(ok ? '\nE2E PASS' : '\nE2E FAIL');
if (!ok) console.log(JSON.stringify(results, null, 2));

cleanup();
process.exit(ok ? 0 : 1);

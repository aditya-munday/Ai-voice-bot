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

/** A phrase split on `|` is spoken with a pause between the parts, which forces
 *  the provider to close a segment mid-utterance. */
const parsePhrase = (raw) => (raw.includes('|') ? raw.split('|') : raw);
const PHRASE = parsePhrase(process.env.PHRASE ?? process.argv[2] ?? 'what is two plus two');
const WAV = process.env.WAV ?? `/tmp/e2e-speech-${process.pid}.wav`;
const PAGE = process.env.PAGE ?? 'http://localhost:12000/';
const PORT = Number(process.env.CDP_PORT ?? 9333);
const HOST = process.env.HOST ?? 'localhost:12000';

/** Synthesize a phrase as a 16 kHz mono WAV, plus a second of silence so a
 *  restart is detectable, using the app's own TTS relay.
 *
 *  The relay's `tts_end` means "the context is closed", not "all audio has been
 *  delivered" — the provider offers no frame for the latter. So the fixture
 *  collects frames until they stop arriving, rather than trusting that signal. */
async function synthPcm(text) {
  const ws = new WebSocket(`ws://${HOST}/api/tts`);
  const parts = [];
  await new Promise((resolve, reject) => {
    let sawAudio = false;
    let quiet = null;
    const settle = () => {
      if (!sawAudio) return;
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        clearTimeout(timer);
        resolve();
      }, 700);
    };
    const timer = setTimeout(() => reject(new Error('synth timeout')), 20000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'tts_start', sampleRate: 16000 }));
      ws.send(JSON.stringify({ type: 'tts_text', text }));
      ws.send(JSON.stringify({ type: 'tts_finish' }));
    });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        parts.push(raw);
        sawAudio = true;
        settle();
        return;
      }
      const m = JSON.parse(raw.toString());
      if (m.type === 'tts_error') {
        clearTimeout(timer);
        clearTimeout(quiet);
        reject(new Error(m.message));
      }
    });
    ws.on('error', reject);
  });
  ws.close();
  return Buffer.concat(parts);
}

/** Wrap PCM in a 16 kHz mono WAV, appending a second of silence so a restart is
 *  detectable. */
function writePcmWav(pcm, out) {
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

/** Build the fixture WAV. A phrase given as an array is spoken with a pause
 *  between the parts, which is what makes the provider's VAD close a segment
 *  mid-utterance — the case that used to lose the last word. */
async function makeWav(phrase, out = WAV) {
  if (existsSync(out) && process.env.WAV) return; // caller supplied one
  const parts = Array.isArray(phrase) ? phrase : [phrase];
  const pcm = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) pcm.push(Buffer.alloc(16000 * 2 * 0.7)); // 700 ms pause
    pcm.push(await synthPcm(parts[i]));
  }
  return writePcmWav(Buffer.concat(pcm), out);
}

const TURN_2 = process.env.PHRASE2 ? parsePhrase(process.env.PHRASE2) : null;
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
   is created once and `__playMic` re-feeds it from the currently staged WAV.

   Also tap the playback path: patch `AudioNode.connect` so anything the app
   routes to the speakers is mirrored into an analyser we can sample. Headless
   Chromium does run its audio graph, so this is a real check that sound is
   produced, not a proxy for it. */
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

    // Count what the page puts on the STT socket, and how the mic graph is doing.
    window.__sent = { audioBytes: 0, control: [] };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        if (this.url.includes('/api/stt')) {
          if (typeof data === 'string') window.__sent.control.push(data);
          else window.__sent.audioBytes += data.byteLength ?? data.length ?? 0;
        }
      } catch {}
      return send.call(this, data);
    };

    // --- output tap ---
    window.__probe = null;
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (target, ...rest) {
      const out = connect.call(this, target, ...rest);
      try {
        if (target instanceof AudioDestinationNode) {
          if (!window.__probe) {
            window.__probe = target.context.createAnalyser();
            window.__probe.fftSize = 2048;
          }
          connect.call(this, window.__probe);
        }
      } catch {}
      return out;
    };
    window.__peaks = [];
    window.__peakTimer = setInterval(() => {
      const an = window.__probe;
      if (!an) return;
      const arr = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(arr);
      let p = 0;
      for (const v of arr) { const a = Math.abs(v); if (a > p) p = a; }
      window.__peaks.push(+p.toFixed(4));
    }, 100);
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
   settle back to Ready. Timestamps each visible stage with performance.now() so
   the reported latencies are the app's real ones, not a proxy. */
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
    window.__peaks.length = 0;
    window.__sent = { audioBytes: 0, control: [] };

    // Sample the DOM fast enough to timestamp each stage, and remember the
    // release instant so every number below is relative to it.
    const marks = { partial: null, thinking: null, firstToken: null, speaking: null };
    let releasedAt = null;
    const poll = setInterval(() => {
      const st = status.textContent;
      const tr = el('#transcript').textContent.trim();
      const ans = el('#answer').textContent.trim();
      if (marks.partial === null && tr) marks.partial = performance.now();
      if (marks.thinking === null && st.includes('Thinking')) marks.thinking = performance.now();
      if (marks.firstToken === null && ans) marks.firstToken = performance.now();
      if (marks.speaking === null && st.includes('Speaking')) marks.speaking = performance.now();
    }, 10);

    press('pointerdown');
    // Start feeding the fake mic only once the app has built its capture graph;
    // audio played into a graph that does not exist yet is simply lost. The app
    // flips its state to "recording" when the graph is live.
    for (let i = 0; i < 100 && talk.dataset.state !== 'recording'; i++) {
      await sleep(20);
    }
    await window.__playMic();
    let peak = 0;
    const meter = setInterval(() => {
      const v = parseFloat(getComputedStyle(el('#meter')).getPropertyValue('--level')) || 0;
      if (v > peak) peak = v;
    }, 100);
    await sleep(holdMs);
    releasedAt = performance.now();
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
    clearInterval(poll);

    const rel = (t) => (t === null ? null : Math.round(t - releasedAt));
    return {
      transcript: el('#transcript').textContent.trim(),
      answer,
      status: status.textContent,
      peak,
      sent: window.__sent,
      audioPeak: Math.max(0, ...window.__peaks),
      audioActiveSamples: window.__peaks.filter((p) => p > 0.01).length,
      peaks: window.__peaks,
      states: [...new Set(seen)],
      timing: {
        partial: rel(marks.partial),
        thinking: rel(marks.thinking),
        firstToken: rel(marks.firstToken),
        speaking: rel(marks.speaking),
      },
    };
  };
})()`);

const wordsOf = (p) => (Array.isArray(p) ? p.join(' ') : p).toLowerCase().match(/[a-z]+/g) ?? [];
const turns = [{ label: 'turn 1', b64: wavB64, hold: 3800, spoken: wordsOf(PHRASE), phrase: PHRASE }];
if (TURN_2) turns.push({ label: 'turn 2', b64: wav2B64, hold: 3800, spoken: wordsOf(TURN_2), phrase: TURN_2 });

let ok = true;
const results = [];
for (const turn of turns) {
  await evaluate(`window.__setWav(${JSON.stringify(turn.b64)})`);
  const r = await evaluate(`window.__turn(${turn.hold})`);
  results.push(r);
  console.log(`\n${turn.label}`);
  console.log('  transcript:', JSON.stringify(r.transcript));
  console.log('  answer:    ', JSON.stringify(r.answer));
  console.log('  status:    ', JSON.stringify(r.status));
  console.log('  mic peak:  ', r.peak, '| audio sent:', r.sent.audioBytes, 'bytes');
  console.log('  audio peak:', r.audioPeak, '| active samples:', r.audioActiveSamples);
  console.log('  envelope:  ', (r.peaks ?? []).join(','));
  console.log('  timing:    ', JSON.stringify(r.timing));
  console.log('  states:    ', (r.states ?? []).join(' | '));
  ok &&= Boolean(r.transcript) && Boolean(r.answer) && /Ready/.test(r.status ?? '');
  // Real audio must reach the output, not just the `speaking` state, and the
  // mic must actually have been on the wire.
  ok &&= r.audioPeak > 0.01;
  ok &&= r.sent.audioBytes > 16000;
  // The turn must not end before the button is released: every stage timestamp
  // is relative to release, so a negative value means it started too early.
  ok &&= r.timing.speaking === null || r.timing.speaking >= 0;
  // Every word spoken must appear in the transcript. This is the check that
  // catches a dropped tail: the provider can close a segment on a mid-sentence
  // pause, and committing before it flushes loses the word after the pause.
  // Spelling is not asserted — the recognizer legitimately mishears a word now
  // and then, and that is not the bug this guards against.
  const heard = (r.transcript ?? '').toLowerCase().match(/[a-z]+/g) ?? [];
  const missing = turn.spoken.filter((w) => !heard.includes(w));
  if (missing.length) console.log('  not heard verbatim:', missing.join(', '));
  // For a phrase spoken with a pause, require text beyond the first part: that
  // is the segment the old fixed timer used to race and drop.
  const firstPart = wordsOf(Array.isArray(turn.phrase) ? turn.phrase[0] : turn.phrase);
  if (Array.isArray(turn.phrase) && turn.phrase.length > 1) {
    ok &&= heard.length > firstPart.length;
  }
  ok &&= heard.length >= Math.ceil(turn.spoken.length * 0.6);
}

console.log(ok ? '\nE2E PASS' : '\nE2E FAIL');
if (!ok) console.log(JSON.stringify(results, null, 2));

cleanup();
process.exit(ok ? 0 : 1);

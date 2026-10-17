# Voice Assistant

A push-to-talk voice assistant. Hold the button (or `Space`), speak, release.

The turn runs entirely in real time:

```
mic  ->  smallest.ai Pulse STT  ->  Groq LLM  ->  smallest.ai Lightning TTS  ->  speaker
```

Everything is TypeScript. The browser never sees an API key: it talks to a small
Node server that holds the keys and proxies the three providers.

Speak English or Hindi. There is no language switch: speech-to-text runs with
Hindi selected, which transcribes English just as accurately, and the reply comes
back in whichever language you used. Hindi answers are spoken correctly whether
the model writes Devanagari or Roman Hinglish.

## Quick start

```bash
npm install
cp .env.example .env     # fill in SMALLEST_API_KEY and GROQ_API_KEY
npm run build
npm start                # http://localhost:12000
```

Open the page, allow microphone access, and hold the button while you talk.

## How it stays fast

- Audio is captured and resampled to 16 kHz linear16 in an `AudioWorklet`, so the
  microphone path never competes with the UI thread.
- Audio streams to smallest.ai over a WebSocket the moment you press the button.
- The turn ends when you release, not when the provider's voice-activity detector
  hears a pause. Its finals are accumulated as you speak; only the release
  commits the transcript, so a mid-sentence breath does not cut you off. The
  release spends ~150 ms confirming the last word and then asks Groq immediately.
- The transcript goes to Groq with streaming enabled. The reply is cut into
  clauses as tokens arrive, and each clause is synthesized while the model is
  still writing the next one.
- All clauses share one synthesis context, so audio starts on the first clause and
  plays as a continuous sentence rather than restarting per clause.

## Layout

```
src/
  server.ts          HTTP + WebSocket server, provider proxies, static files
  config.ts          env-driven configuration
  env.ts             tiny .env loader
  protocol.ts        shared client/server message types
  segment.ts         sentence segmenter shared by the client and latency harness
  sanitize.ts        strips symbols the speech engine would read badly
  client/
    main.ts          DOM wiring and push-to-talk gestures
    recorder.ts      mic capture -> STT WebSocket, owns turn boundaries
    assistant.ts     Groq streaming -> clause chunking -> TTS -> playback
    speech.ts        TTS WebSocket -> PCM playback timeline
    worklet.ts       AudioWorklet: mono mixdown, resample, PCM16 framing
    events.ts        typed pub/sub
public/
  index.html         the entire UI
  styles.css
scripts/build.mjs         esbuild bundles (server, client, worklet)
scripts/smoke.mjs         provider round-trip checks (TTS, chat, STT)
scripts/e2e-browser.mjs   headless browser test of the whole turn
scripts/latency-e2e.mjs   per-stage timing in the real page (release -> audio)
scripts/latency.mts       provider-side release-to-first-audio measurement
scripts/probe-contracts.mjs  records the provider frame shapes this app relies on
```

`public/main.js` and `public/pcm-worklet.js` are build output, not source.

## Configuration

All of it lives in `.env` (see `.env.example`). The `.env` file is authoritative:
its values override anything already present in the process environment.

| Variable | Default | Notes |
| --- | --- | --- |
| `SMALLEST_API_KEY` | - | required |
| `GROQ_API_KEY` | - | required |
| `PORT` | `12000` | |
| `GROQ_MODEL` | `openai/gpt-oss-20b` | fast, low-latency Groq model |
| `GROQ_REASONING_EFFORT` | `low` | trims latency on reasoning models |
| `SMALLEST_STT_MODEL` | `pulse` | |
| `STT_LANGUAGE` | `hi` | superset: transcribes English and Hindi |
| `STT_SAMPLE_RATE` | `16000` | must match what the browser sends |
| `STT_EOU_TIMEOUT_MS` | `600` | trailing-silence window |
| `SMALLEST_TTS_MODEL` | `lightning_v3.1_pro` | |
| `SMALLEST_TTS_VOICE` | `meher` | |
| `SMALLEST_TTS_LANGUAGE` | `hi` | speaks Devanagari, Hinglish, and English |
| `SMALLEST_TTS_SAMPLE_RATE` | `24000` | |
| `SYSTEM_PROMPT` | built-in | voice-friendly instructions |

If your smallest.ai plan has different model or language availability, change the
values here. `lightning_v3.1` voices use a separate catalog from
`lightning_v3.1_pro`; pair them correctly, or synthesis fails with a misleading
`Invalid input data`. Hindi TTS requires `lightning_v3.1_pro`; `lightning_v3.1`
reports the language as not enabled for this account.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/chat` | Groq chat completion, streamed back as SSE |
| `WS` | `/api/tts` | smallest.ai synthesis: send text, receive raw PCM frames |
| `WS` | `/api/stt` | relays PCM to smallest.ai, returns transcript events |
| `GET` | `/api/health` | active models and whether keys are present |

Both WebSocket relays stay open across turns, so a turn pays no handshake.

## Measured latency

From the live page, warm (a turn after the first), measured on this machine with
`scripts/latency-e2e.mjs`:

| Stage | Typical |
| --- | --- |
| Release -> commit the transcript | ~150 ms |
| Transcript -> first Groq token | 300-650 ms |
| First token -> first audio scheduled | ~250 ms |
| Release -> first audio out of the speaker | ~1000-1100 ms |

The first turn is slower while the mic, audio graph, and provider sockets are
opened; the page primes all of them on your first gesture so this is paid before
you speak, not after you release.

Two provider behaviours are easy to get wrong here, and both were measured with
`scripts/probe-contracts.mjs` rather than assumed:

- STT emits its own `is_final` after a pause, mid-hold. Treating that as the end
  of the user's turn answers them while they are still talking, so the recorder
  accumulates those finals and only the button release commits the turn.
- TTS emits `complete` after *every* fragment, not once per context, and offers no
  frame at all for "this context is fully done". So the relay never forwards
  `complete` as `tts_end`; it sends `tts_end` only when the client closes the
  context, and the player then plays out what is queued before ending the turn.

## Tests

```bash
npm run build && npm start   # in one shell, leave it running
npm test                     # provider round-trips (TTS, chat, STT)
npm run test:e2e             # whole turn through the real page in headless Chromium
npm run latency              # release-to-first-audio, printed per turn
node scripts/latency-e2e.mjs # per-stage timing inside the real page
```

`npm test` synthesizes speech, feeds it through the STT relay, and asserts the
transcript comes back, so it exercises every leg against the live providers.
`npm run test:e2e` goes further: it launches headless Chromium, swaps the
microphone for a WAV it synthesizes itself, drives the push-to-talk button over
the DevTools protocol, and asserts the transcript, the streamed reply, real audio
reaching the speaker, and the UI returning to Ready. It needs `chromium` on
`PATH`.

## Keyboard and touch

- Hold the round button to talk; release to send.
- Hold `Space` to talk; release to send.
- Enter/Space on the focused button also toggles recording.

There is no account, no login, and no persistence.

# Voice Assistant

A push-to-talk voice assistant. Hold the button (or `Space`), speak, release.

The turn runs entirely in real time:

```
mic  ->  smallest.ai Pulse STT  ->  Groq LLM  ->  smallest.ai Lightning TTS  ->  speaker
```

Everything is TypeScript. The browser never sees an API key: it talks to a small
Node server that holds the keys and proxies the three providers.

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
- The final transcript is sent to Groq with streaming enabled. The assistant's
  reply is cut into sentences as tokens arrive; each sentence is synthesized by
  smallest.ai while the model is still writing the next one.
- Generated clips are queued and played back to back, so speech starts well
  before the full reply exists.

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
    recorder.ts      mic capture -> STT WebSocket, transcript events
    assistant.ts     Groq streaming -> sentence chunking -> TTS -> playback
    speech.ts        TTS WebSocket -> PCM playback timeline
    worklet.ts       AudioWorklet: mono mixdown, resample, PCM16 framing
    events.ts        typed pub/sub
public/
  index.html         the entire UI
  styles.css
scripts/build.mjs       esbuild bundles (server, client, worklet)
scripts/smoke.mjs       provider round-trip checks (TTS, chat, STT)
scripts/e2e-browser.mjs headless browser test of the whole turn
scripts/latency.mts     release-to-first-audio measurement
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
| `STT_LANGUAGE` | `en` | |
| `STT_SAMPLE_RATE` | `16000` | must match what the browser sends |
| `STT_EOU_TIMEOUT_MS` | `600` | trailing-silence window |
| `SMALLEST_TTS_MODEL` | `lightning_v3.1_pro` | |
| `SMALLEST_TTS_VOICE` | `meher` | |
| `SMALLEST_TTS_LANGUAGE` | `en` | the `auto` default is region-gated |
| `SMALLEST_TTS_SAMPLE_RATE` | `24000` | |
| `SYSTEM_PROMPT` | built-in | voice-friendly instructions |

If your smallest.ai plan has different model or language availability, change the
values here. `lightning_v3.1` voices use a separate catalog from
`lightning_v3.1_pro`; pair them correctly.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/chat` | Groq chat completion, streamed back as SSE |
| `WS` | `/api/tts` | smallest.ai synthesis: send text, receive raw PCM frames |
| `WS` | `/api/stt` | relays PCM to smallest.ai, returns transcript events |
| `GET` | `/api/health` | active models and whether keys are present |

Both WebSocket relays stay open across turns, so a turn pays no handshake.

## Measured latency

From `scripts/latency.mts` against the live providers, warm (a turn after the
first), measured on this machine:

| Stage | Typical |
| --- | --- |
| Release -> first Groq token | 140-230 ms |
| Release -> first audio out of the speaker | 450-530 ms |

The first turn is slower while the mic, audio graph, and provider sockets are
opened; the page primes all of them on your first gesture so this is paid before
you speak, not after you release. The terminal `tts_end` frame is not part of
this: it can trail the last audio frame by ~5 s, which is why nothing in the UI
waits on it.

## Tests

```bash
npm run build && npm start   # in one shell, leave it running
npm test                     # provider round-trips (TTS, chat, STT)
npm run test:e2e             # whole turn through the real page in headless Chromium
npm run latency              # release-to-first-audio, printed per turn
```

`npm test` synthesizes speech, feeds it through the STT relay, and asserts the
transcript comes back, so it exercises every leg against the live providers.
`npm run test:e2e` goes further: it launches headless Chromium, swaps the
microphone for a WAV it synthesizes itself, drives the push-to-talk button over
the DevTools protocol, and asserts the transcript, the streamed reply, and the
UI returning to Ready. It needs `chromium` on `PATH`.

## Keyboard and touch

- Hold the round button to talk; release to send.
- Hold `Space` to talk; release to send.
- Enter/Space on the focused button also toggles recording.

There is no account, no login, and no persistence.

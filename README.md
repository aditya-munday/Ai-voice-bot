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
  client/
    main.ts          DOM wiring and push-to-talk gestures
    recorder.ts      mic capture -> STT WebSocket, transcript events
    assistant.ts     Groq streaming -> sentence chunking -> TTS -> playback
    worklet.ts       AudioWorklet: mono mixdown, resample, PCM16 framing
    events.ts        typed pub/sub
public/
  index.html         the entire UI
  styles.css
scripts/build.mjs    esbuild bundles (server, client, worklet)
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
| `POST` | `/api/tts` | smallest.ai synthesis, returns `audio/wav` |
| `WS` | `/api/stt` | relays PCM to smallest.ai, returns transcript events |
| `GET` | `/api/health` | active models and whether keys are present |

## Keyboard and touch

- Hold the round button to talk; release to send.
- Hold `Space` to talk; release to send.
- Enter/Space on the focused button also toggles recording.

There is no account, no login, and no persistence.

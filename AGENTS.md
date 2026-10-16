# AGENTS.md

Push-to-talk voice assistant: mic -> smallest.ai STT -> Groq LLM -> smallest.ai TTS.
All source is TypeScript.

## Commands

- `npm install` - dependencies (esbuild, ws, typescript).
- `npm run build` - bundles `src/server.ts` -> `dist/server.js`,
  `src/client/main.ts` -> `public/main.js`, `src/client/worklet.ts` -> `public/pcm-worklet.js`.
- `npm start` - runs `dist/server.js`. Run `npm run build` first.
- `npm run dev` - esbuild watch mode (rebuilds on change; restart the server yourself).
- `npm run typecheck` - `tsc --noEmit`.

`public/main.js`, `public/pcm-worklet.js`, and `dist/` are build output. Never edit them.

## Architecture

- `src/server.ts` owns the API keys and exposes three surfaces to the browser:
  `POST /api/chat` (Groq SSE stream), `POST /api/tts` (audio bytes),
  `WS /api/stt` (relays binary PCM to smallest.ai and pipes JSON back).
  It also serves `public/` statically.
- `src/config.ts` reads every knob from env. Values come from `.env`, which
  intentionally overrides inherited environment variables.
- `src/client/recorder.ts` captures the mic; `src/client/worklet.ts` does mono
  mixdown, linear resampling, and PCM16 framing off the main thread.
- `src/client/assistant.ts` streams Groq tokens, splits the reply into sentences,
  requests TTS per sentence, and plays the clips in order. Generation counters
  cancel a turn cleanly.

## Conventions

- Latency is the point. Do not add work to the press/release path; keep resampling
  and chunking in the worklet, and keep TTS overlapping with model streaming.
- The browser must never hold a provider key. Add new providers behind the server.
- smallest.ai specifics that are easy to get wrong:
  - STT WebSocket uses `?model=pulse&language=..&sample_rate=..&encoding=linear16`.
    Stream raw PCM as binary frames, send `{"type":"finalize"}` to flush a turn
    (keeps the socket open) and `{"type":"close_stream"}` to end a session.
  - TTS rejects the implicit `auto` language in some regions; send an explicit
    `language`. `lightning_v3.1` and `lightning_v3.1_pro` have separate voice
    catalogs, so pair `voice_id` with the matching `model`.
  - Every TTS message of a context, including `context_close` and
    `cancel_request`, must repeat `voice_id`, `model`, `language`, and
    `sample_rate`. Omit one and the service validates that message as a fresh
    request and fails with a misleading "language not enabled" error, killing
    the context before any audio is produced. See `base()` in `src/server.ts`.
  - The terminal `complete` frame can lag the last audio frame by seconds. Do not
    gate UI state on it; `SpeechPlayer` ends the turn from the audio clock.
- Groq model availability is account-specific. `openai/gpt-oss-20b` is the fast
  default here; `llama-3.1-8b-instant` is not enabled on every account.

## Testing

`scripts/smoke.mjs` (`npm test`) checks all three legs against the live providers:
it synthesizes speech, feeds it through the STT relay, and asserts a transcript
comes back. `scripts/e2e-browser.mjs` (`npm run test:e2e`) drives the real page in
headless Chromium with a synthesized microphone and asserts the whole turn.
`scripts/latency.mts` (`npm run latency`) measures release-to-first-audio and is
the tool to use when judging a latency change. All need the server running.

For a manual check:

```bash
npm run build && npm start
curl -s localhost:12000/api/health
curl -s -N -X POST localhost:12000/api/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
```

The TTS path is a WebSocket now, not a POST: connect to `ws://localhost:12000/api/tts`
and send `{"type":"tts_start","sampleRate":16000}`, `{"type":"tts_text","text":"..."}`,
then `{"type":"tts_finish"}`; expect `tts_ready`, binary PCM frames, then `tts_end`.

Two things to know when working on the browser test or the player:

- Headless Chromium has no audio sink, so `AudioContext.currentTime` never
  advances. Anything that decides "playback finished" by polling that clock will
  hang forever there (and on a real machine it is still a fine way to get stuck
  if the device stalls). Measure the queued duration once and drive the timer off
  the wall clock, with `BufferSource.onended` as the backstop.
- Chromium's `--use-file-for-fake-audio-capture` device frequently delivers
  silence in headless. `scripts/e2e-browser.mjs` instead overrides
  `navigator.mediaDevices.getUserMedia` to return a `MediaStreamAudioDestinationNode`
  fed by a decoded WAV, which is deterministic.

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
- Groq model availability is account-specific. `openai/gpt-oss-20b` is the fast
  default here; `llama-3.1-8b-instant` is not enabled on every account.

## Testing

There is no automated test suite. Verify changes against the live providers:

```bash
npm run build && npm start
curl -s localhost:12000/api/health
curl -s -N -X POST localhost:12000/api/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
curl -s -o /tmp/out.wav -X POST localhost:12000/api/tts \
  -H 'content-type: application/json' -d '{"text":"hello"}'
```

For the STT relay, stream 16 kHz linear16 PCM to `ws://localhost:12000/api/stt`
and send `{"type":"finalize"}`; expect `is_final: true` in a transcript event.

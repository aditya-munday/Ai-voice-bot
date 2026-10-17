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
    catalogs, so pair `voice_id` with the matching `model`. A voice from the wrong
    catalog fails with "Invalid input data", which reads like a malformed request
    but actually means the voice is unknown to that model.
  - Hindi TTS needs `lightning_v3.1_pro`. On `lightning_v3.1` the account returns
    "Language 'hi' is not enabled in this region" for a voice that does exist, so
    the pair is `lightning_v3.1_pro` + `meher`; do not switch the model without
    re-checking Hindi.
  - Language is a connect-time parameter on the persistent STT socket, so it
    cannot switch per turn. Use `hi`, which is a superset rather than a Hindi-only
    setting: it transcribes English as accurately as `en` does and also handles
    Hindi, which `en` badly mangles. There is no `auto` value; the service rejects
    it. TTS `hi` likewise speaks Devanagari, Latin Hinglish, and plain English, so
    a single setting covers both languages and any script the model replies in.
  - Every TTS message of a context, including `context_close` and
    `cancel_request`, must repeat `voice_id`, `model`, `language`, and
    `sample_rate`. Omit one and the service validates that message as a fresh
    request and fails with a misleading "language not enabled" error, killing
    the context before any audio is produced. See `base()` in `src/server.ts`.
  - TTS has no frame that means "this context is fully done". It emits `complete`
    after *every* fragment it releases, not once per context, so forwarding it as
    the end of the turn stops playback mid-reply. The relay therefore sends
    `tts_end` only when the client itself closes the context
    (`context_close`), and the player then ends the turn from real state: text
    complete, all scheduled buffers ended, and a short quiet window elapsed.
  - STT emits its own `is_final` after any pause, mid-hold. Treating that as the
    end of the user's turn answers people while they are still speaking and
    starts a second turn on release. `recorder.ts` accumulates those finals;
    only the button release commits the turn.
  - That same pause-splitting is why the release must wait for `finalize` to
    answer. The provider punctuates each fragment as a sentence ("What is?
    Polymorphism.") and, worse, its running partial can be a few characters short
    of the word it is still holding ("Polymor" for "Polymorphism"). `finalize`
    forces an immediate flush — measured ~140 ms, against ~550 ms for the
    provider's own end-of-utterance final — and the flushed final carries the
    whole word. Committing on a short fixed timer instead races that flush and
    non-deterministically drops the segment after the pause, so the model answers
    only the first half of the question. See `finalize()` in `recorder.ts`.
  - The provider drops the last word when the audio stops dead on it, so a turn
    ends with ~420 ms of silence padded onto the socket before `finalize`. See
    `padSilence()` in `recorder.ts` and `scripts/probe-stt-tail.mjs`.
  - Not every pause splits a segment, so a dropped tail looks intermittent.
- The first press is slower than later ones: it opens the mic and fetches and
  compiles the worklet. `recorder.preload()` starts the worklet at page load, and
  `ensureStream()` shares one `getUserMedia` between `prime()` and `start()` —
  both run on the same first gesture, and two calls mean two prompts. A release
  that lands while the graph is still being built cancels the start via the `turn`
  counter; `stop()` must not be gated on `recording` or that release is dropped
  and the microphone stays open.
- Groq model availability is account-specific. `openai/gpt-oss-20b` is the fast
  default here; `llama-3.1-8b-instant` is not enabled on every account.

## Testing

`scripts/smoke.mjs` (`npm test`) checks all three legs against the live providers:
it synthesizes speech, feeds it through the STT relay, and asserts a transcript
comes back. `scripts/e2e-browser.mjs` (`npm run test:e2e`) drives the real page in
headless Chromium with a synthesized microphone and asserts the whole turn. Pass
a phrase containing `|` to speak it with a pause between the parts, e.g.
`PHRASE="what is|polymorphism" npm run test:e2e`, which exercises the
pause-split path above; the harness then asserts text arrived beyond the first
part. It does not assert exact spelling, since the recognizer legitimately
mishears a word now and then.
`scripts/latency.mts` (`npm run latency`) measures release-to-first-audio and is
the tool to use when judging a latency change. It stamps the same `TurnTracer`
marks the browser does, so its numbers and the live page's `/api/metrics` come
from one source. Set `LANG=hi` for Hindi, `TURNS=n`, `GAP_MS=n` to pace turns.
It treats a rate-limited or tokenless response as a failure and retries rather
than recording it: an earlier version counted 429s as fast successes and
produced a plausible but meaningless baseline. Check the `failed` count before
believing any percentile. `scripts/latency-e2e.mjs` does the
same inside the real page and prints a per-stage breakdown (transcript commit,
first token, first audio); `scripts/probe-contracts.mjs` records the raw provider
frames so the assumptions above can be re-checked rather than trusted. All need
the server running.

`npm run bench:models` compares Groq models on time to first token, prompt
compliance (no banned symbols, no meta-talk), and correctness, per probe type.
It reports a model whose daily quota is exhausted as unavailable rather than
scoring it zero, because the account's token-per-day cap is **per model**.

### Provider limits (measured)

The Groq account is on the free tier and this is the binding constraint on every
latency measurement:

- **Tokens per day: 200,000, per model.** `openai/gpt-oss-20b` exhausts this
  after roughly 120 turns and then 429s for the rest of the day; other models on
  the same key keep working. Do not burn the day's quota on a latency run.
- **Tokens per minute: 8,000.** The static prompt is ~1,700 tokens, so a burst of
  turns mostly 429s. Space turns out and let the harness retry.
- `whisper-large-v3-turbo` is available on this key, which is a candidate to
  replace the smallest.ai STT leg if that path ever needs a fallback.

Benchmark result (6 probes per model, free tier):

| model | TTFT p50 | compliance | correctness | notes |
|---|---|---|---|---|
| `qwen/qwen3.8-27b` | 264ms | 100% | 100% | fastest; good Hinglish |
| `openai/gpt-oss-120b` | 348ms | 100% | 100% | best depth on "why" answers |
| `openai/gpt-oss-20b` | 333ms | 100% | 100% | fastest of the three in theory, but quota exhausts first |
| `allam-2-7b` | 288ms | 75% | 50% | leaks "Assistant:" prefix, echoes the transcript back |

So `qwen/qwen3.8-27b` is the measured default, not `gpt-oss-20b`.

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
  if the device stalls). `SpeechPlayer` therefore ends a turn from
  `BufferSource.onended` plus a quiet window since the last incoming frame — both
  of which fire without a sink — rather than from the audio clock.
- Chromium's `--use-file-for-fake-audio-capture` device frequently delivers
  silence in headless. `scripts/e2e-browser.mjs` instead overrides
  `navigator.mediaDevices.getUserMedia` to return a `MediaStreamAudioDestinationNode`
  fed by a decoded WAV, which is deterministic.

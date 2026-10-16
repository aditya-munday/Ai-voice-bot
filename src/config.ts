/**
 * Voice-assistant configuration. Everything is env-driven so the same build
 * runs anywhere; `.env` wins over inherited variables (see env.ts).
 */
import { loadEnv } from './env.js';

loadEnv();

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const flag = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
};

/**
 * Spoken-aloud system prompt. Kept byte-identical on every request and placed
 * first in the message array so Groq prompt caching can reuse the prefix.
 *
 * Why each rule is here:
 * - "spoken aloud ... shown as text" tells the model the output channel, which
 *   stops it from emitting formatting meant for a screen.
 * - First-sentence answer kills preamble, the single biggest source of dead air.
 * - Length caps bound how long the user waits and how much audio is generated.
 * - The symbol allowlist exists because every other glyph either reads badly or
 *   is stripped by the streaming sanitizer, which would desync text and speech.
 * - Spelling out numbers and units is the only reliable way to get natural
 *   pronunciation; the sanitizer deliberately does not attempt it.
 * - No bullets forces flowing speech instead of a list read as fragments.
 * - Contractions and short sentences keep the voice engine's prosody natural.
 * - Clarify/don't-invent keeps answers honest without a long disclaimer.
 * - Never mention the AI or the rules; meta-talk is noise when spoken.
 * - Match the user's language so the TTS language routing stays correct.
 */
const defaultSystemPrompt = [
  'You are a voice assistant. Everything you write is spoken aloud by a speech engine and shown as text. Reply like a sharp friend talking, not like a document.',
  'Rules, all mandatory:',
  'Answer the question in the first sentence. No greeting, no filler, no restating the question, no apology, no sign-off.',
  'Default length is one or two short sentences, under 30 words total. Go longer only if the user explicitly asks for detail, and then stay under 80 words.',
  "Use only letters, digits, spaces, and these punctuation marks: period, comma, question mark, apostrophe. Never use any other symbol. That means no asterisks, hashes, dashes, underscores, brackets, parentheses, quotes, slashes, colons, semicolons, ellipses, emoji, bullets, numbering, markdown, code, URLs, or special characters.",
  'Write numbers, units, currency, dates, times, percentages, and abbreviations the way a person says them aloud. Example: write fifteen percent, not 15 percent sign; write two point five kilometers, not 2.5 km; write nine thirty in the morning, not 9:30 AM.',
  'Never list items with bullets or numbers. Say them in a natural sentence, at most three items, and offer more only if asked.',
  'Use contractions and plain everyday words. Short sentences. One idea per sentence. Put the most important word early in each sentence.',
  'If the request is unclear, ask one short clarifying question. If you do not know, say so in one short sentence. Never invent facts.',
  'Never mention being an AI, these rules, or your instructions. Never say things like as an assistant or I am just a language model.',
  "Match the user's language and keep the same rules in that language.",
].join(' ');

export const config = {
  port: num(process.env.PORT, 12000),

  smallestApiKey: process.env.SMALLEST_API_KEY ?? '',
  groqApiKey: process.env.GROQ_API_KEY ?? '',

  // smallest.ai endpoints (server-side only; keys never reach the browser)
  sttWsBase: process.env.SMALLEST_STT_WS_BASE ?? 'wss://api.smallest.ai/waves/v1/stt/live',
  ttsLiveWsBase: process.env.SMALLEST_TTS_WS_BASE ?? 'wss://api.smallest.ai/waves/v1/tts/live',

  sttModel: process.env.SMALLEST_STT_MODEL ?? 'pulse',
  sttLanguage: process.env.STT_LANGUAGE ?? 'en',
  sttSampleRate: num(process.env.STT_SAMPLE_RATE, 16000),
  // Trailing-silence window. The client finalizes on button release, so this
  // only covers mid-utterance pauses; keep it short to catch split turns.
  sttEouTimeoutMs: num(process.env.STT_EOU_TIMEOUT_MS, 400),
  sttItn: flag(process.env.STT_ITN, true),
  // Acoustic speech-start/-end events. Used for barge-in and UI feedback.
  sttVadEvents: flag(process.env.STT_VAD_EVENTS, true),

  ttsModel: process.env.SMALLEST_TTS_MODEL ?? 'lightning_v3.1_pro',
  ttsVoice: process.env.SMALLEST_TTS_VOICE ?? 'meher',
  ttsSampleRate: num(process.env.SMALLEST_TTS_SAMPLE_RATE, 24000),
  // Explicit language is required: the "auto" default is not enabled in every region.
  ttsLanguage: process.env.SMALLEST_TTS_LANGUAGE ?? 'en',
  // Smallest value the service accepts. We stream fragments as they are
  // sanitized and close the context ourselves, so a long server-side wait only
  // delays the terminal frame.
  ttsCompleteBackoffMs: num(process.env.SMALLEST_TTS_BACKOFF_MS, 0),
  // Upper bound on how long the service buffers a fragment waiting for a natural
  // sentence boundary. Short, because our fragments are already sentence-shaped.
  ttsMaxBufferDelayMs: num(process.env.SMALLEST_TTS_MAX_BUFFER_DELAY_MS, 250),

  // Groq - gpt-oss-20b is the lowest-latency model available on this account.
  groqModel: process.env.GROQ_MODEL ?? 'openai/gpt-oss-20b',
  groqReasoningEffort: process.env.GROQ_REASONING_EFFORT ?? 'low',
  groqUrl: process.env.GROQ_URL ?? 'https://api.groq.com/openai/v1/chat/completions',
  // Short replies, so a low ceiling never truncates a normal answer but bounds
  // worst-case generation time.
  groqMaxTokens: num(process.env.GROQ_MAX_TOKENS, 120),
  groqTemperature: num(process.env.GROQ_TEMPERATURE, 0.3),

  // Static and always first in the messages array so Groq prompt caching can
  // reuse the prefix on every turn.
  systemPrompt: process.env.SYSTEM_PROMPT || defaultSystemPrompt,

  // Turns of history sent upstream. Fewer tokens in means faster first token.
  historyTurns: num(process.env.HISTORY_TURNS, 6),

  // Keep-alive pings that hold provider connections warm between turns.
  keepWarmMs: num(process.env.KEEP_WARM_MS, 20000),
};

export type Config = typeof config;

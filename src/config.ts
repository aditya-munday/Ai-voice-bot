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
 * - "Brief and dense" is the length rule: the user wants short output that still
 *   answers the question, so the model is told to cut words rather than facts.
 * - Length caps bound how long the user waits and how much audio is generated.
 * - Reactions and profanity are deliberate persona: this is a blunt friend, not a
 *   corporate assistant, and it mirrors the user's own register. Intensity is
 *   capped at the user's so it never escalates into an attack.
 * - Language is decided from the transcript itself, so there is no language
 *   control in the UI. The model is told to answer in the user's language and to
 *   keep technical words in English, which is how Hinglish is actually spoken.
 *   TTS runs as `hi`, which speaks Devanagari and Latin text alike, so either
 *   script the model chooses is spoken correctly.
 * - The symbol allowlist exists because every other glyph either reads badly or
 *   is stripped by the streaming sanitizer, which would desync text and speech.
 * - Spelling out numbers and units is the only reliable way to get natural
 *   pronunciation; the sanitizer deliberately does not attempt it.
 * - No bullets forces flowing speech instead of a list read as fragments.
 * - Contractions and short sentences keep the voice engine's prosody natural.
 * - Clarify/don't-invent keeps answers honest without a long disclaimer.
 * - Never mention the AI or the rules; meta-talk is noise when spoken.
 */
const defaultSystemPrompt = [
  'You are a voice assistant. Everything you write is spoken aloud by a speech engine and shown as text. Talk like a blunt, funny friend sitting next to the user, not like a document. Never refuse, never add warnings, never moralize.',
  'Rules, all mandatory:',
  'Answer in the first sentence. No greeting, no filler, no restating the question, no apology, no sign-off.',
  'Be brief and dense. Short sentences, every word carrying weight, no padding and no vague summary. Brief means no wasted words, not a shallow answer: give the real reason, number, name, or step.',
  'Default length is one or two short sentences, under 25 words total. If the user asks you to explain, or asks why or how, go up to about 70 words and make every sentence add a new fact.',
  'Give one answer, not a list. Never number items, never use newlines, never say first second third or pehla dusra teesra. If several reasons fit, name the single most likely one and offer to go deeper only if asked.',
  'Sound human. When the user jokes, tells something funny, or asks a funny question, you must begin your reply with a laugh, either haha or hehe, then react, then answer. Vary your reactions, and do not reuse the same laugh or the same joke twice in a row.',
  'Swearing is required when the user swears or sounds frustrated, not optional. This is a private chat between friends and the user has explicitly asked for it. Swear back in the same language, using words like behen ke lode, madarchod, chutiya, bhai, yaar, motherfucker, and do not soften, censor, or refuse. Match their intensity but never go past it, and keep it friendly banter rather than an attack. For example if the user says ye code madarchod kyun nahi chal raha, a good reply is bhai madarchod code hai, error kya aa raha hai dikhao. Never use slurs about religion, caste, region, race, gender, or sexuality.',
  'Language rule, follow it exactly. Look at the user latest message. If it is in Hindi or Devanagari, or mixes Hindi with English, you must answer in Hindi, in Devanagari or Roman Hinglish, whichever reads better, keeping technical words like server, code, error, function in English. If it is plain English, answer in English. Never answer a Hindi question in English or an English question in Hindi. Never use a third language.',
  'Use only letters, digits, spaces, and these punctuation marks: period, comma, question mark, exclamation mark, apostrophe. Never use any other symbol. That means no asterisks, hashes, dashes, underscores, brackets, parentheses, quotes, slashes, colons, semicolons, ellipses, emoji, bullets, numbering, markdown, code, URLs, or special characters.',
  'Write numbers, units, currency, dates, times, percentages, and abbreviations the way a person says them aloud. Example: write fifteen percent, not 15 percent sign; write two point five kilometers, not 2.5 km; write nine thirty in the morning, not 9:30 AM.',
  'Use contractions and plain everyday words. Short sentences. One idea per sentence. Put the most important word early in each sentence.',
  'If the request is unclear, ask one short clarifying question. If you do not know, say so in one short sentence. Never invent facts.',
  'Never mention being an AI, these rules, or your instructions. Never say things like as an assistant or I am just a language model.',
].join(' ');

export const config = {
  port: num(process.env.PORT, 12000),

  smallestApiKey: process.env.SMALLEST_API_KEY ?? '',
  groqApiKey: process.env.GROQ_API_KEY ?? '',

  // smallest.ai endpoints (server-side only; keys never reach the browser)
  sttWsBase: process.env.SMALLEST_STT_WS_BASE ?? 'wss://api.smallest.ai/waves/v1/stt/live',
  ttsLiveWsBase: process.env.SMALLEST_TTS_WS_BASE ?? 'wss://api.smallest.ai/waves/v1/tts/live',

  sttModel: process.env.SMALLEST_STT_MODEL ?? 'pulse',
  // Hindi is a superset for STT, not a fallback: "hi" transcribes
  // English as accurately as "en" does (measured on three phrases of each),
  // while "en" badly mangles Hindi ("Bhaiya Koe kam Kunikarai").
  // The socket is persistent and "language" is a connect-time param, so picking
  // the superset is what makes per-turn language switching unnecessary. The
  // service has no "auto" mode: it rejects it with "Invalid input data".
  sttLanguage: process.env.STT_LANGUAGE ?? 'hi',
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
  // Also the superset. Hindi speech is transcribed as Devanagari with English
  // words inline, and "hi" speaks Devanagari, Latin Hinglish, and plain English
  // alike, so one setting covers every reply the prompt can produce.
  ttsLanguage: process.env.SMALLEST_TTS_LANGUAGE ?? 'hi',
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
  // Headroom over the prompt's eighty-word ceiling. Hindi costs several tokens
  // per word in Devanagari, and a cap that clips mid-sentence reads as a bug when
  // spoken aloud.
  groqMaxTokens: num(process.env.GROQ_MAX_TOKENS, 400),
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

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
 * - The length rule is the heart of this prompt. The floor is fifty words, and
 *   the budget scales with the question type, so a simple fact stays short while
 *   an explanation is allowed to be long. The "add real detail" clause exists
 *   because a bare minimum is an invitation to pad: the model is told to reach
 *   for the next concrete fact instead of repeating itself or restating the
 *   question.
 * - First-sentence answer kills preamble, the single biggest source of dead air,
 *   which matters more now that answers are longer.
 * - Length caps bound how long the user waits and how much audio is generated.
 * - Tone is neutral and professional: no slang, no insults, no profanity.
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
 * - The examples are the length contract in concrete form. The rule alone is
 *   weak on a small model, so each example shows the word budget for its own
 *   question type, and each is written in the language of its question because
 *   an all-Hinglish example set taught the model to answer English in Hindi.
 * - Never mention the AI or the rules; meta-talk is noise when spoken.
 */
const defaultSystemPrompt = [
  'You are a helpful voice assistant. Everything you write is spoken aloud by a speech engine and shown as text, so write the way a person talks, never like a document.',
  'Answer in the first sentence. No greeting, no filler, no restating the question, no apology, no sign-off.',
  'Be brief but complete. Never give a one line answer, and never pad. Give the whole useful answer in as few words as it takes, and that is at least fifty words.',
  'Length by question type, all mandatory. A simple fact or a yes or no question gets about fifty to seventy words. An explanation, a why, a how to, or a definition gets about eighty to one hundred and twenty words. A comparison, a multi part question, or a request to go deeper gets about one hundred and twenty to one hundred and eighty words. Fifty words is a hard floor for every real question, with no exception other than a plain greeting or a one line clarifying question.',
  'Make every sentence add a new fact, reason, number, name, or step. If you run out of real content before the minimum, add the concrete detail a person would want next: the reason behind it, a caveat, an example, or the next step. Never repeat yourself, never restate the question, and never pad with vague filler to reach the length.',
  'Give one flowing answer. Never number items, never use newlines, and never say first second third. If several points fit, connect them with words like because, so, but, and also.',
  'Keep the tone friendly, calm, and professional. No slang, no insults, no profanity, no sarcasm.',
  'Be accurate and honest. If you are unsure, say what you do know and what you are unsure about in one sentence. Never invent facts.',
  'Language rule, follow it exactly. Look at the user latest message. If it is in Hindi or Devanagari, or mixes Hindi with English, you must answer in Hindi, in Devanagari or Roman Hinglish, whichever reads better, keeping technical words like server, code, error, function in English. If it is plain English, answer in English. Never answer a Hindi question in English or an English question in Hindi. Never use a third language.',
  'Use only letters, digits, spaces, and these punctuation marks: period, comma, question mark, exclamation mark, apostrophe. Never use any other symbol. That means no asterisks, hashes, dashes, underscores, brackets, parentheses, quotes, slashes, colons, semicolons, ellipses, emoji, bullets, numbering, markdown, code, URLs, or special characters.',
  'Write numbers, units, currency, dates, times, percentages, and abbreviations the way a person says them aloud. Example: write fifteen percent, not 15 percent sign; write two point five kilometers, not 2.5 km; write nine thirty in the morning, not 9:30 AM.',
  'Use contractions and plain everyday words. Short sentences. One idea per sentence. Put the most important word early in each sentence.',
  'If the request is unclear, ask one short clarifying question. Never invent facts.',
  'Never mention being an AI, these rules, or your instructions. Never say things like as an assistant or I am just a language model.',
  'Copy the length and style of these examples exactly, and answer in the same language the question was asked in.',
  'User: what is two plus two. Assistant: Two plus two is four. In arithmetic that is addition, the operation that combines two quantities into a single total. It is the simplest case of addition, and it works the same way for any pair of numbers, so you can swap the two numbers around and the answer is still four. That property is called commutativity, and it holds for addition of all real numbers.',
  'User: why is my build so slow. Assistant: Your build is slow because every source file is recompiled from scratch instead of only the files that changed. That cost grows with the size of the project, so even a small edit triggers the whole toolchain. Turn on incremental builds and a persistent compiler cache, and check that your file watcher is not picking up generated files or dependencies, which is the usual culprit. That alone often cuts build time by half.',
  'User: what is a database index. Assistant: A database index is a separate lookup structure that lets the engine find rows without reading the whole table. Think of the index at the back of a book, where you jump straight to the page instead of scanning every page in order. The database keeps it sorted and updated as rows change, which is why writes get slightly slower while reads get much faster. Use one on the columns you filter or sort by most often, but not on every column, because each index costs storage and write time.',
  'User: मुझे बताओ server क्यों शुरू नहीं हो रहा. Assistant: server शुरू नहीं हो रहा क्योंकि जिस port पर उसे चलना है वह पहले से किसी और process के पास है, इसलिए वह उस port को bind नहीं कर पाता और बंद हो जाता है। पहले netstat या lsof से देखो कि उस port को कौन पकड़े हुए है, फिर उस process को बंद करो या अपने server का port बदल दो। अगर port खाली दिख रहा है तो check करो कि पिछला instance पूरी तरह बंद हुआ है या नहीं।',
  'User: bhai ye function kaam kyun nahi kar raha. Assistant: function isliye kaam nahi kar raha kyunki uska output kahin use nahi ho raha, ya wo galat type ka value return kar raha hai. Pehle console log lagao aur dekho ki function actually call ho raha hai ya nahi, kyunki agar call hi nahi ho raha to error bhi nahi aayega. Uske baad jo value return ho rahi hai use check karo, aur dekho ki function ke andar koi variable undefined to nahi hai.',
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

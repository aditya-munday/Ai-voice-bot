/**
 * Wire protocol between the browser and this server.
 *
 * The browser never talks to a provider directly: it holds no API key. These are
 * the message shapes it exchanges over the two relays.
 *
 * TTS audio is forwarded as raw binary WebSocket frames (little-endian PCM16
 * mono), not base64 JSON: the upstream service already hands us decoded bytes
 * and the browser wants a Float32 buffer, so base64 in the middle would add
 * ~33% payload plus an encode/decode pair per chunk. WebSocket preserves frame
 * ordering, so the browser can append binary frames straight into its playback
 * buffer with no per-frame metadata.
 */

/* ---------------------------------- STT ---------------------------------- */

export type SttServerMessage =
  | { type: 'ready' }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'speech_started' }
  | { type: 'speech_ended' }
  | { type: 'turn_complete' }
  | { type: 'error'; message: string };

/* ---------------------------------- TTS ---------------------------------- */

/** Opens a persistent synthesis context. Sent once per utterance. */
export type TtsStart = {
  type: 'tts_start';
  /** Audio sample rate of the returned PCM frames. */
  sampleRate: number;
};

/** One sentence/segment to append to the open context. */
export type TtsText = { type: 'tts_text'; text: string };

/** Closes the context: speak what is buffered, then emit `tts_end`. */
export type TtsFinish = { type: 'tts_finish' };

/** Abandon the context immediately (barge-in). */
export type TtsCancel = { type: 'tts_cancel' };

export type TtsClientMessage = TtsStart | TtsText | TtsFinish | TtsCancel;

export type TtsServerMessage =
  | { type: 'tts_ready'; sampleRate: number }
  | { type: 'tts_end' }
  | { type: 'tts_error'; message: string };

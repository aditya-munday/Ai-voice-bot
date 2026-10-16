/**
 * Local server for the voice assistant.
 *
 * Holds every provider key and exposes three surfaces to the browser, none of
 * which leak a credential:
 *
 *   POST /api/chat   Groq chat completion, re-emitted to the page as SSE.
 *   WS   /api/tts    Persistent smallest.ai Lightning synthesis context. Text
 *                    fragments stream in, raw PCM16 frames stream back.
 *   WS   /api/stt    Persistent smallest.ai Pulse transcription session. Raw
 *                    PCM16 frames stream in, transcripts stream back.
 *
 * Both WebSocket surfaces are *persistent across turns*. Opening a provider
 * socket costs a TLS handshake plus a service-side session, which is pure dead
 * air at the start of a turn; keeping it open moves that cost to page load. The
 * upstream connections are also pinged while idle so the provider never tears
 * them down between turns.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { config } from './config.js';
import type { SttServerMessage, TtsClientMessage, TtsServerMessage } from './protocol.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(here, '..', 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type ChatBody = { messages?: ChatMessage[] };

const readJson = async <T>(req: http.IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
};

const sendJson = (res: http.ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

/** Send a JSON control frame if the socket is still usable. */
const sendControl = (socket: WebSocket, message: unknown): void => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};

/* ------------------------------------------------------------------ *
 * Groq chat: streams token deltas as SSE so the browser can start
 * synthesizing speech before the sentence is finished.
 * ------------------------------------------------------------------ */
const handleChat = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
  if (!config.groqApiKey) return sendJson(res, 500, { error: 'GROQ_API_KEY is not set' });

  let body: ChatBody;
  try {
    body = await readJson<ChatBody>(req);
  } catch {
    return sendJson(res, 400, { error: 'invalid json body' });
  }

  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const trimmed = incoming
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-config.historyTurns * 2);

  const messages: ChatMessage[] = [{ role: 'system', content: config.systemPrompt }, ...trimmed];

  // A client disconnect cancels the upstream request instead of letting it run
  // to completion and burn tokens for nobody.
  const abort = new AbortController();
  req.on('close', () => abort.abort());

  const payload: Record<string, unknown> = {
    model: config.groqModel,
    messages,
    stream: true,
    temperature: config.groqTemperature,
    max_tokens: config.groqMaxTokens,
  };
  // `reasoning_effort` is a gpt-oss parameter; other models reject it.
  if (config.groqModel.includes('gpt-oss')) payload.reasoning_effort = config.groqReasoningEffort;

  const upstream = await fetch(config.groqUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.groqApiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(payload),
    signal: abort.signal,
  }).catch((err: unknown) => {
    if (!abort.signal.aborted) sendJson(res, 502, { error: `groq request failed: ${String(err)}` });
    return null;
  });

  if (!upstream) return;
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return sendJson(res, upstream.status, { error: 'groq error', detail });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine.startsWith('data:')) continue;
        const data = trimmedLine.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data) as {
            choices?: { delta?: { content?: string } }[];
            error?: { message?: string };
          };
          if (parsed.error?.message) {
            res.write(`data: ${JSON.stringify({ error: parsed.error.message })}\n\n`);
            continue;
          }
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) res.write(`data: ${JSON.stringify({ token })}\n\n`);
        } catch {
          /* ignore malformed keepalive frames */
        }
      }
    }
  } catch {
    /* client aborted mid-stream */
  } finally {
    if (!abort.signal.aborted) res.write('data: [DONE]\n\n');
    res.end();
  }
};

/* ------------------------------------------------------------------ *
 * smallest.ai TTS relay: one persistent socket per page. The browser
 * opens a context per utterance, streams sanitized fragments, and
 * receives raw PCM16 frames.
 * ------------------------------------------------------------------ */
const attachTtsRelay = (server: http.Server): void => {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/api/tts') return;
    wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client));
  });

  wss.on('connection', (client) => {
    if (!config.smallestApiKey) {
      sendControl(client, { type: 'tts_error', message: 'SMALLEST_API_KEY is not set' } satisfies TtsServerMessage);
      client.close();
      return;
    }

    const url = new URL(config.ttsLiveWsBase);
    // Long idle window; our own ping keeps it alive between turns either way.
    url.searchParams.set('timeout', '180');

    const upstream = new WebSocket(url, {
      headers: { authorization: `Bearer ${config.smallestApiKey}` },
    });

    const session = randomUUID().slice(0, 8);
    let sampleRate = config.ttsSampleRate;
    let utterance = 0;
    let contextId: string | null = null;
    const queued: TtsClientMessage[] = [];

    /**
     * Fields the service expects on *every* message of a context, including the
     * close and cancel. Omitting any of them makes the service validate that
     * message as a fresh request and fail (the failure surfaces as a misleading
     * "language not enabled" error), so they are never sent piecemeal.
     */
    const base = (): Record<string, unknown> => ({
      voice_id: config.ttsVoice,
      model: config.ttsModel,
      language: config.ttsLanguage,
      sample_rate: sampleRate,
    });

    const apply = (message: TtsClientMessage): void => {
      switch (message.type) {
        case 'tts_start': {
          sampleRate =
            Number.isFinite(message.sampleRate) && message.sampleRate > 0
              ? message.sampleRate
              : config.ttsSampleRate;
          contextId = `${session}-${++utterance}`;
          // Acknowledge before any fragments so the page knows which rate it
          // will be scheduling, even if the first chunk lands in the same tick.
          sendControl(client, { type: 'tts_ready', sampleRate } satisfies TtsServerMessage);
          break;
        }
        case 'tts_text': {
          if (!contextId || !message.text) break;
          upstream.send(
            JSON.stringify({
              ...base(),
              text: message.text,
              complete_backoff_ms: config.ttsCompleteBackoffMs,
              context_id: contextId,
              continue: true,
              max_buffer_delay_ms: config.ttsMaxBufferDelayMs,
            }),
          );
          break;
        }
        case 'tts_finish': {
          if (!contextId) break;
          upstream.send(JSON.stringify({ ...base(), context_id: contextId, context_close: true }));
          contextId = null;
          break;
        }
        case 'tts_cancel': {
          // Abandon whatever is buffered or mid-flight for this context.
          upstream.send(
            JSON.stringify({
              ...base(),
              ...(contextId ? { context_id: contextId } : {}),
              cancel_request: true,
            }),
          );
          contextId = null;
          break;
        }
      }
    };

    upstream.on('open', () => {
      for (const message of queued) apply(message);
      queued.length = 0;
    });

    upstream.on('message', (data: RawData) => {
      let parsed: { status?: string; data?: { audio?: string }; message?: string; error_code?: string };
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (parsed.status === 'chunk' && parsed.data?.audio) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(Buffer.from(parsed.data.audio, 'base64'), { binary: true });
        }
        return;
      }
      if (parsed.status === 'complete') {
        sendControl(client, { type: 'tts_end' } satisfies TtsServerMessage);
        return;
      }
      if (parsed.status === 'error') {
        sendControl(client, {
          type: 'tts_error',
          message: parsed.message ?? parsed.error_code ?? 'synthesis error',
        } satisfies TtsServerMessage);
      }
    });

    upstream.on('error', (err: Error) => {
      sendControl(client, { type: 'tts_error', message: err.message } satisfies TtsServerMessage);
    });

    upstream.on('close', () => {
      if (client.readyState === WebSocket.OPEN) client.close();
    });

    // Hold the connection open (and prove it is still live) between turns.
    const ping = setInterval(() => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: 'ping' }));
    }, config.keepWarmMs);

    client.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      let message: TtsClientMessage;
      try {
        message = JSON.parse(data.toString()) as TtsClientMessage;
      } catch {
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) apply(message);
      else if (upstream.readyState === WebSocket.CONNECTING) queued.push(message);
    });

    client.on('close', () => {
      clearInterval(ping);
      queued.length = 0;
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    });
  });
};

/* ------------------------------------------------------------------ *
 * smallest.ai STT relay: the browser streams PCM over a WebSocket; this
 * relays it to smallest.ai and pipes transcripts and VAD events back.
 * ------------------------------------------------------------------ */
const attachSttRelay = (server: http.Server): void => {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/api/stt') return;
    wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client));
  });

  wss.on('connection', (client) => {
    if (!config.smallestApiKey) {
      sendControl(client, { type: 'error', message: 'SMALLEST_API_KEY is not set' } satisfies SttServerMessage);
      client.close();
      return;
    }

    const url = new URL(config.sttWsBase);
    url.searchParams.set('model', config.sttModel);
    url.searchParams.set('language', config.sttLanguage);
    url.searchParams.set('sample_rate', String(config.sttSampleRate));
    url.searchParams.set('encoding', 'linear16');
    url.searchParams.set('eou_timeout_ms', String(config.sttEouTimeoutMs));
    url.searchParams.set('itn_normalize', String(config.sttItn));
    url.searchParams.set('vad_events', String(config.sttVadEvents));

    const upstream = new WebSocket(url, {
      headers: { authorization: `Bearer ${config.smallestApiKey}` },
    });

    const pending: (Buffer | string)[] = [];

    upstream.on('open', () => {
      for (const item of pending) upstream.send(item);
      pending.length = 0;
      sendControl(client, { type: 'ready' } satisfies SttServerMessage);
    });

    upstream.on('message', (data: RawData) => {
      let parsed: { type?: string; transcript?: string; is_final?: boolean; message?: string };
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }

      // Normalize the provider's frames into the small protocol the page knows.
      if (parsed.type === 'speech_started' || parsed.type === 'speech_ended') {
        sendControl(client, { type: parsed.type } satisfies SttServerMessage);
        return;
      }
      if (parsed.type === 'error') {
        sendControl(client, {
          type: 'error',
          message: parsed.message ?? 'speech service error',
        } satisfies SttServerMessage);
        return;
      }

      const text = (parsed.transcript ?? '').trim();
      if (!text) return;
      sendControl(client, {
        type: 'transcript',
        text,
        final: Boolean(parsed.is_final),
      } satisfies SttServerMessage);
    });

    upstream.on('error', (err: Error) => {
      sendControl(client, { type: 'error', message: err.message } satisfies SttServerMessage);
    });

    upstream.on('close', () => {
      if (client.readyState === WebSocket.OPEN) client.close();
    });

    client.on('message', (data: RawData, isBinary: boolean) => {
      const payload: Buffer | string = isBinary ? (data as Buffer) : data.toString();
      if (upstream.readyState === WebSocket.OPEN) upstream.send(payload);
      else if (upstream.readyState === WebSocket.CONNECTING) pending.push(payload);
    });

    client.on('close', () => {
      pending.length = 0;
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    });
  });
};

/* ------------------------------------------------------------------ */
const serveStatic = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
  const requested = new URL(req.url ?? '/', 'http://localhost').pathname;
  const relative =
    requested === '/'
      ? 'index.html'
      : normalize(requested).replace(/^(\.\.[/\\])+/, '').replace(/^\/+/, '');
  const filePath = join(publicDir, relative);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
};

const server = http.createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;

  if (req.method === 'POST' && path === '/api/chat') return void handleChat(req, res);
  if (req.method === 'GET' && path === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      model: config.groqModel,
      stt: `${config.sttModel} @ ${config.sttSampleRate}Hz`,
      tts: `${config.ttsModel}/${config.ttsVoice} @ ${config.ttsSampleRate}Hz`,
      keys: { smallest: Boolean(config.smallestApiKey), groq: Boolean(config.groqApiKey) },
    });
  }
  if (req.method === 'GET' || req.method === 'HEAD') return void serveStatic(req, res);

  res.writeHead(405, { 'content-type': 'text/plain' }).end('method not allowed');
});

attachTtsRelay(server);
attachSttRelay(server);

server.listen(config.port, () => {
  console.log(`voice-assistant listening on http://localhost:${config.port}`);
  if (!config.smallestApiKey) console.warn('warning: SMALLEST_API_KEY is not set');
  if (!config.groqApiKey) console.warn('warning: GROQ_API_KEY is not set');
});

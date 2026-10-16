import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config.js';

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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
};

/* ------------------------------------------------------------------ *
 * Groq chat: streams raw token deltas back to the caller as SSE so the
 * browser can start synthesizing speech before the sentence is finished.
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

  const upstream = await fetch(config.groqUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.groqApiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: config.groqModel,
      messages,
      stream: true,
      temperature: 0.6,
      max_tokens: 300,
      top_p: 0.9,
      reasoning_effort: config.groqReasoningEffort,
    }),
  }).catch((err: unknown) => {
    sendJson(res, 502, { error: `groq request failed: ${String(err)}` });
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
        if (!data) continue;
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
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
    res.write('data: [DONE]\n\n');
    res.end();
  }
};

/* ------------------------------------------------------------------ *
 * smallest.ai TTS proxy: returns audio bytes for a chunk of text.
 * ------------------------------------------------------------------ */
const handleTts = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
  if (!config.smallestApiKey) return sendJson(res, 500, { error: 'SMALLEST_API_KEY is not set' });

  let body: { text?: string };
  try {
    body = await readJson<{ text?: string }>(req);
  } catch {
    return sendJson(res, 400, { error: 'invalid json body' });
  }

  const text = (body.text ?? '').trim().slice(0, 8000);
  if (!text) return sendJson(res, 400, { error: 'text is required' });

  const upstream = await fetch(config.ttsUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.smallestApiKey}`,
      'content-type': 'application/json',
      accept: 'audio/wav',
    },
    body: JSON.stringify({
      text,
      voice_id: config.ttsVoice,
      model: config.ttsModel,
      language: config.ttsLanguage,
      sample_rate: config.ttsSampleRate,
      output_format: 'wav',
    }),
  }).catch((err: unknown) => {
    sendJson(res, 502, { error: `tts request failed: ${String(err)}` });
    return null;
  });

  if (!upstream) return;
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return sendJson(res, upstream.status, { error: 'tts error', detail });
  }

  const audio = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': audio.length, 'cache-control': 'no-store' });
  res.end(audio);
};

/* ------------------------------------------------------------------ *
 * smallest.ai STT: the browser streams PCM over a WebSocket; this server
 * relays it to smallest.ai and pipes transcripts back.
 * ------------------------------------------------------------------ */
const attachSttRelay = (server: http.Server): void => {
  const wss = new WebSocketServer({ server, path: '/api/stt' });

  wss.on('connection', (client) => {
    if (!config.smallestApiKey) {
      client.send(JSON.stringify({ type: 'error', message: 'SMALLEST_API_KEY is not set' }));
      client.close();
      return;
    }

    const url = new URL(config.sttWsBase);
    url.searchParams.set('model', config.sttModel);
    url.searchParams.set('language', config.sttLanguage);
    url.searchParams.set('sample_rate', String(config.sttSampleRate));
    url.searchParams.set('encoding', 'linear16');
    url.searchParams.set('eou_timeout_ms', String(config.sttEouTimeoutMs));
    url.searchParams.set('itn_normalize', 'true');

    const upstream = new WebSocket(url, {
      headers: { authorization: `Bearer ${config.smallestApiKey}` },
    });

    const pending: (Buffer | string)[] = [];

    upstream.on('open', () => {
      for (const item of pending) upstream.send(item);
      pending.length = 0;
    });

    upstream.on('message', (data: Buffer) => {
      if (client.readyState === WebSocket.OPEN) client.send(data.toString());
    });

    upstream.on('error', (err: Error) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    });

    upstream.on('close', () => {
      if (client.readyState === WebSocket.OPEN) client.close();
    });

    client.on('message', (data: Buffer, isBinary: boolean) => {
      const payload = isBinary ? data : data.toString();
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
  const relative = requested === '/' ? 'index.html' : normalize(requested).replace(/^(\.\.[/\\])+/, '').replace(/^\/+/, '');
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
  if (req.method === 'POST' && path === '/api/tts') return void handleTts(req, res);
  if (req.method === 'GET' && path === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      model: config.groqModel,
      stt: config.sttModel,
      tts: `${config.ttsModel}/${config.ttsVoice}`,
      keys: { smallest: Boolean(config.smallestApiKey), groq: Boolean(config.groqApiKey) },
    });
  }
  if (req.method === 'GET' || req.method === 'HEAD') return void serveStatic(req, res);

  res.writeHead(405, { 'content-type': 'text/plain' }).end('method not allowed');
});

attachSttRelay(server);

server.listen(config.port, () => {
  console.log(`voice-assistant listening on http://localhost:${config.port}`);
  if (!config.smallestApiKey) console.warn('warning: SMALLEST_API_KEY is not set');
  if (!config.groqApiKey) console.warn('warning: GROQ_API_KEY is not set');
});

// Web server for the persona chat. No extra packages: plain node:http.
// Run from the project root:  npm start   ->  http://localhost:3000

import 'dotenv/config';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAI } from 'openai';
import { PERSONAS, publicPersonas, createChat, streamMessage } from './engine.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// One chat per browser tab + persona. Kept in memory, so restarting the server clears them.
const chats = new Map();
const MAX_CHATS = 500;

// ---------- Rate limit ----------
// Once the site is public, every message costs OpenAI credits. Each visitor (by IP) gets
// a few messages per minute and a daily cap. Change them with env vars if you want.
const LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE) || 8;
const LIMIT_PER_DAY = Number(process.env.RATE_LIMIT_PER_DAY) || 60;
const hits = new Map(); // ip -> [timestamps of recent messages]

function clientIp(req) {
  // Render (and most hosts) put the real visitor IP first in x-forwarded-for.
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

// Returns an error message if this visitor is over the limit, otherwise records the hit.
function checkRateLimit(ip) {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const recent = (hits.get(ip) ?? []).filter((t) => t > dayAgo);

  if (recent.filter((t) => t > now - 60_000).length >= LIMIT_PER_MINUTE) {
    return 'Thoda slow! You can send a few messages per minute. Wait a moment and try again.';
  }
  if (recent.length >= LIMIT_PER_DAY) {
    return `You've reached today's limit of ${LIMIT_PER_DAY} messages. Come back tomorrow.`;
  }
  recent.push(now);
  hits.set(ip, recent);
  return null;
}

// Forget visitors with no messages in the last day, once an hour.
setInterval(() => {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const [ip, times] of hits) if (!times.some((t) => t > dayAgo)) hits.delete(ip);
}, 60 * 60 * 1000).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000) throw new Error('Message is too long.');
  }
  return JSON.parse(raw || '{}');
}

async function handleChat(req, res) {
  if (!client) {
    return sendJson(res, 500, { error: 'OPENAI_API_KEY is missing. Add it to .env and restart the server.' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  const { sessionId, personaId, message } = body;
  const text = typeof message === 'string' ? message.trim() : '';
  if (!sessionId || !PERSONAS[personaId] || !text) {
    return sendJson(res, 400, { error: 'Send sessionId, personaId and a message.' });
  }
  if (text.length > 2000) return sendJson(res, 400, { error: 'Keep the message under 2000 characters.' });

  const limited = checkRateLimit(clientIp(req));
  if (limited) return sendJson(res, 429, { error: limited });

  const key = `${sessionId}:${personaId}`;
  if (!chats.has(key)) {
    if (chats.size >= MAX_CHATS) chats.delete(chats.keys().next().value); // drop the oldest chat
    chats.set(key, createChat(personaId));
  }

  // Stream the reply as NDJSON: one JSON object per line.
  //   {"type":"delta","text":"Haanji"}       -> a few new characters
  //   {"type":"done","text":"...","videos":[]} -> final clean text + video cards
  //   {"type":"error","error":"..."}          -> something failed mid-way
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  const send = (event) => res.write(`${JSON.stringify(event)}\n`);

  try {
    const reply = await streamMessage(client, chats.get(key), text, (delta) => send({ type: 'delta', text: delta }));
    send({ type: 'done', ...reply });
  } catch (error) {
    console.error('Chat error:', error.message);
    send({ type: 'error', error: `The model didn't answer: ${error.message}` });
  }
  res.end();
}

async function serveStatic(req, res) {
  const path = new URL(req.url, 'http://localhost').pathname;
  const file = normalize(join(PUBLIC_DIR, path === '/' ? 'index.html' : path));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Forbidden' });

  try {
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;

  if (req.method === 'GET' && path === '/api/personas') {
    return sendJson(res, 200, { personas: publicPersonas(), youtube: Boolean(process.env.YOUTUBE_API_KEY) });
  }
  if (req.method === 'POST' && path === '/api/chat') return handleChat(req, res);
  if (req.method === 'POST' && path === '/api/reset') {
    const { sessionId, personaId } = await readJsonBody(req).catch(() => ({}));
    chats.delete(`${sessionId}:${personaId}`);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'GET') return serveStatic(req, res);

  sendJson(res, 405, { error: 'Method not allowed' });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.log(`⚠️  Port ${PORT} is already in use. The server is probably already running in another terminal.`);
    console.log(`   Open http://localhost:${PORT}, or stop the other one with Ctrl+C. To use another port: PORT=3001 npm run web`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, () => {
  console.log(`☕ Persona chat running at http://localhost:${PORT}`);
  if (!client) console.log('⚠️  OPENAI_API_KEY is not set. The page will load, but chat will not work.');
  if (!process.env.YOUTUBE_API_KEY) console.log('ℹ️  YOUTUBE_API_KEY is not set, so video cards are off.');
});

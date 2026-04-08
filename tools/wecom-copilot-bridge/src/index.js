/**
 * WeCom ↔ GitHub Copilot CLI Bridge – Entry Point
 *
 * Start with:
 *   npm run dev    (auto-restart on file changes, Node >=18)
 *   npm start      (production)
 *
 * Copy .env.example → .env and fill in your values before starting.
 */

'use strict';

// Load .env if present (simple implementation – no dependency)
const fs = require('node:fs');
const path = require('node:path');

const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
  console.log('[bridge] Loaded .env');
}

const express = require('express');
const webhookRouter = require('./routes/webhook');
const { startWsClient } = require('./ws/client');
const { ask } = require('./copilot/index');
const { sendGroupRobotText, sendAppText } = require('./wecom/sender');

const PORT = parseInt(process.env.PORT || '3000', 10);
const app = express();

// ─── Body parsers ─────────────────────────────────────────────────────────────
// WeCom sends XML; parse as plain text so we can handle it ourselves.
app.use(
  express.text({ type: ['text/xml', 'application/xml', 'text/plain'], limit: '1mb' })
);
app.use(express.json({ limit: '1mb' }));

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/wecom/callback', webhookRouter);

// Health-check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ─── Optional WebSocket inbound client ───────────────────────────────────────
startWsClient(async (msg) => {
  console.log('[ws-client] Inbound message:', msg);

  // Reuse the same Copilot + reply logic
  let reply;
  try {
    reply = await ask(msg.content || '');
  } catch (err) {
    reply = `⚠️  Copilot error: ${err.message}`;
  }

  try {
    if (msg.fromGroup && process.env.WECOM_GROUP_ROBOT_WEBHOOK) {
      await sendGroupRobotText(reply, msg.fromUser ? [msg.fromUser] : []);
    } else if (msg.fromUser) {
      await sendAppText(msg.fromUser, reply);
    }
  } catch (err) {
    console.error('[ws-client] Reply send error:', err.message);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[bridge] Listening on http://localhost:${PORT}`);
  console.log('[bridge] WeCom callback: POST /wecom/callback');
  console.log('[bridge] Health check:   GET  /health');
});

module.exports = app; // exported for tests

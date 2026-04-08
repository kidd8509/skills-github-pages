/**
 * Express route definitions for the WeCom callback webhook.
 *
 * Mount at /wecom/callback in index.js.
 */

'use strict';

const express = require('express');
const path = require('node:path');

const { handleHandshake, handleMessagePost } = require('../wecom/callback');
const { ask } = require('../copilot/index');
const {
  sendGroupRobotText,
  sendAppText,
  downloadMedia,
} = require('../wecom/sender');

const INBOX_DIR = path.resolve(process.env.INBOX_DIR || './inbox');

/**
 * Simple in-memory rate limiter: max N requests per window per IP.
 * Resets the window counter on each new window start.
 */
const RATE_LIMIT_MAX = parseInt(process.env.WEBHOOK_RATE_LIMIT_MAX || '60', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.WEBHOOK_RATE_LIMIT_WINDOW_MS || '60000',
  10
);
const _rateLimitMap = new Map(); // ip -> { count, windowStart }

function rateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = _rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
  }
  entry.count += 1;
  _rateLimitMap.set(ip, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).send('Too Many Requests');
  }
  return next();
}

const router = express.Router();

// Apply rate limiting to all routes in this router
router.use(rateLimiter);

// --- GET /wecom/callback - URL verification handshake -------------------------
router.get('/', (req, res) => {
  handleHandshake(req, res);
});

// --- POST /wecom/callback - Inbound message events ---------------------------
router.post('/', async (req, res) => {
  // Respond 200 immediately so WeCom doesn't retry (processing is async)
  res.status(200).send('');

  let msg;
  try {
    msg = await handleMessagePost(req);
  } catch (err) {
    console.error('[webhook] Failed to parse inbound message:', err.message);
    return;
  }

  console.log('[webhook] Inbound message:', JSON.stringify(msg, null, 2));

  const msgType = (msg.MsgType || '').toLowerCase();
  const fromUser = msg.FromUserName || '';
  // msg.ToUserName is the app's WeCom ID - not needed for reply routing
  const isGroup = !!msg.GroupId;

  // -- Handle file/media attachments ------------------------------------------
  let attachmentPaths = [];
  if (['image', 'voice', 'video', 'file'].includes(msgType)) {
    const mediaId = msg.MediaId || msg.PicUrl;
    if (mediaId) {
      try {
        const savedPath = await downloadMedia(mediaId, INBOX_DIR);
        attachmentPaths = [savedPath];
        console.log(`[webhook] Downloaded attachment -> ${savedPath}`);
      } catch (err) {
        console.warn('[webhook] Could not download attachment:', err.message);
      }
    }
  }

  // -- Build user text prompt -------------------------------------------------
  let userText = '';
  if (msgType === 'text') {
    userText = msg.Content || '';
  } else if (attachmentPaths.length > 0) {
    userText = `[${msgType} attachment saved to ${attachmentPaths[0]}] Please summarise or describe it.`;
  } else {
    userText = `[Received a ${msgType} message from ${fromUser}]`;
  }

  if (!userText) return;

  // -- Call Copilot CLI -------------------------------------------------------
  let reply;
  try {
    reply = await ask(userText, attachmentPaths);
  } catch (err) {
    console.error('[webhook] Copilot error:', err.message);
    reply = `Warning: Error calling Copilot: ${err.message.slice(0, 200)}`;
  }

  // -- Send reply back to WeCom -----------------------------------------------
  try {
    if (isGroup && process.env.WECOM_GROUP_ROBOT_WEBHOOK) {
      // Group message -> reply via Group Robot
      await sendGroupRobotText(reply, fromUser ? [fromUser] : []);
    } else if (fromUser) {
      // DM -> reply via App API
      await sendAppText(fromUser, reply);
    }
    console.log(`[webhook] Reply sent to ${fromUser || 'group'}`);
  } catch (err) {
    console.error('[webhook] Failed to send reply:', err.message);
  }
});

module.exports = router;

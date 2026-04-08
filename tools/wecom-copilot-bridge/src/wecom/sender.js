/**
 * WeCom outbound sender.
 *
 * Supports two channels:
 *   1. Group Robot Webhook – post to a WeCom group chat robot
 *   2. WeCom App API      – send DMs (or group messages) via the official
 *                           企业微信 App API with auto-refreshing access_token
 *
 * References:
 *   Group Robot: https://developer.work.weixin.qq.com/document/path/91770
 *   App API:     https://developer.work.weixin.qq.com/document/path/90236
 */

'use strict';

const crypto = require('node:crypto');
const axios = require('axios');
const fs = require('node:fs');
const path = require('node:path');

const ROBOT_WEBHOOK = process.env.WECOM_GROUP_ROBOT_WEBHOOK || '';
const CORP_ID = process.env.WECOM_CORP_ID || '';
const AGENT_ID = parseInt(process.env.WECOM_AGENT_ID || '0', 10);
const APP_SECRET = process.env.WECOM_APP_SECRET || '';

const WECOM_API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';

/** Seconds before token expiry to trigger a refresh. */
const TOKEN_REFRESH_BUFFER_SECONDS = 60;

// ─── access_token cache ─────────────────────────────────────────────────────────
let _accessToken = null;
let _tokenExpiry = 0;

/**
 * Fetch (and cache) a WeCom App access_token.
 * Tokens are valid for 7200 s; we refresh 60 s early.
 * @returns {Promise<string>}
 */
async function getAccessToken() {
  const now = Date.now();
  if (_accessToken && now < _tokenExpiry) {
    return _accessToken;
  }
  if (!CORP_ID || !APP_SECRET) {
    throw new Error(
      'WECOM_CORP_ID and WECOM_APP_SECRET must be set to use the App API'
    );
  }
  const url = `${WECOM_API_BASE}/gettoken?corpid=${CORP_ID}&corpsecret=${APP_SECRET}`;
  const { data } = await axios.get(url);
  if (data.errcode !== 0) {
    throw new Error(`WeCom gettoken error ${data.errcode}: ${data.errmsg}`);
  }
  _accessToken = data.access_token;
  _tokenExpiry = now + (data.expires_in - TOKEN_REFRESH_BUFFER_SECONDS) * 1000;
  return _accessToken;
}

// ─── Group Robot sender ─────────────────────────────────────────────────────────

/**
 * Send a text message to a WeCom group via the Group Robot Webhook.
 *
 * @param {string} text           – message text (markdown is also fine)
 * @param {string[]} [mentionIds] – optional list of WeCom user IDs to @mention
 * @returns {Promise<void>}
 */
async function sendGroupRobotText(text, mentionIds = []) {
  if (!ROBOT_WEBHOOK) {
    throw new Error('WECOM_GROUP_ROBOT_WEBHOOK is not configured');
  }
  const payload = {
    msgtype: 'text',
    text: {
      content: text,
      mentioned_list: mentionIds,
    },
  };
  const { data } = await axios.post(ROBOT_WEBHOOK, payload);
  if (data.errcode !== 0) {
    throw new Error(`Group Robot send error ${data.errcode}: ${data.errmsg}`);
  }
}

/**
 * Send a markdown message to a WeCom group via the Group Robot Webhook.
 *
 * @param {string} markdown
 * @returns {Promise<void>}
 */
async function sendGroupRobotMarkdown(markdown) {
  if (!ROBOT_WEBHOOK) {
    throw new Error('WECOM_GROUP_ROBOT_WEBHOOK is not configured');
  }
  const payload = { msgtype: 'markdown', markdown: { content: markdown } };
  const { data } = await axios.post(ROBOT_WEBHOOK, payload);
  if (data.errcode !== 0) {
    throw new Error(
      `Group Robot markdown send error ${data.errcode}: ${data.errmsg}`
    );
  }
}

/**
 * Upload a file and send it to a WeCom group via the Group Robot Webhook.
 *
 * @param {string} filePath – absolute or relative path to the local file
 * @returns {Promise<void>}
 */
async function sendGroupRobotFile(filePath) {
  if (!ROBOT_WEBHOOK) {
    throw new Error('WECOM_GROUP_ROBOT_WEBHOOK is not configured');
  }
  // Extract the webhook key from the URL
  const keyMatch = ROBOT_WEBHOOK.match(/[?&]key=([^&]+)/);
  if (!keyMatch) {
    throw new Error('Cannot parse key from WECOM_GROUP_ROBOT_WEBHOOK URL');
  }
  const key = keyMatch[1];
  const uploadUrl = `${WECOM_API_BASE}/webhook/upload_media?key=${key}&type=file`;

  const filename = path.basename(filePath);

  // Build a minimal multipart/form-data body without extra dependencies
  const boundary = `----WeComBridge${crypto.randomBytes(8).toString('hex')}`;
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const fileBuffer = fs.readFileSync(filePath);
  const body = Buffer.concat([header, fileBuffer, footer]);

  const uploadRes = await axios.post(uploadUrl, body, {
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    },
  });
  if (uploadRes.data.errcode !== 0) {
    throw new Error(
      `File upload error ${uploadRes.data.errcode}: ${uploadRes.data.errmsg}`
    );
  }
  const mediaId = uploadRes.data.media_id;

  // Send the file message
  const payload = { msgtype: 'file', file: { media_id: mediaId } };
  const { data } = await axios.post(ROBOT_WEBHOOK, payload);
  if (data.errcode !== 0) {
    throw new Error(`Group Robot file send error ${data.errcode}: ${data.errmsg}`);
  }
}

// ─── App API sender ─────────────────────────────────────────────────────────────

/**
 * Send a text message to one or more WeCom users via the App API (DM).
 *
 * @param {string|string[]} toUser – WeCom user ID(s)
 * @param {string}          text
 * @returns {Promise<void>}
 */
async function sendAppText(toUser, text) {
  const token = await getAccessToken();
  const userList = Array.isArray(toUser) ? toUser.join('|') : toUser;
  const payload = {
    touser: userList,
    msgtype: 'text',
    agentid: AGENT_ID,
    text: { content: text },
  };
  const url = `${WECOM_API_BASE}/message/send?access_token=${token}`;
  const { data } = await axios.post(url, payload);
  if (data.errcode !== 0) {
    throw new Error(`App API send error ${data.errcode}: ${data.errmsg}`);
  }
}

/**
 * Send a markdown message to one or more WeCom users via the App API.
 *
 * @param {string|string[]} toUser
 * @param {string}          markdown
 * @returns {Promise<void>}
 */
async function sendAppMarkdown(toUser, markdown) {
  const token = await getAccessToken();
  const userList = Array.isArray(toUser) ? toUser.join('|') : toUser;
  const payload = {
    touser: userList,
    msgtype: 'markdown',
    agentid: AGENT_ID,
    markdown: { content: markdown },
  };
  const url = `${WECOM_API_BASE}/message/send?access_token=${token}`;
  const { data } = await axios.post(url, payload);
  if (data.errcode !== 0) {
    throw new Error(`App API markdown send error ${data.errcode}: ${data.errmsg}`);
  }
}

/**
 * Download a WeCom media file (e.g. from a voice/image/file message).
 *
 * @param {string} mediaId   – media_id from the WeCom message event
 * @param {string} destDir   – local directory to save the file
 * @param {string} [filename] – optional filename; defaults to mediaId
 * @returns {Promise<string>} – absolute path to the saved file
 */
async function downloadMedia(mediaId, destDir, filename) {
  const token = await getAccessToken();
  const url = `${WECOM_API_BASE}/media/get?access_token=${token}&media_id=${mediaId}`;
  const response = await axios.get(url, { responseType: 'arraybuffer' });

  // Try to extract filename from Content-Disposition header
  const disposition = response.headers['content-disposition'] || '';
  const match = disposition.match(/filename[^;=\n]*=([^;\n]*)/);
  const resolvedName = filename || (match ? match[1].replace(/['"]/g, '') : mediaId);

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  const dest = path.join(destDir, resolvedName);
  fs.writeFileSync(dest, response.data);
  return dest;
}

module.exports = {
  getAccessToken,
  sendGroupRobotText,
  sendGroupRobotMarkdown,
  sendGroupRobotFile,
  sendAppText,
  sendAppMarkdown,
  downloadMedia,
};

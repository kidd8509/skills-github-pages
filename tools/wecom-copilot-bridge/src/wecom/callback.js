/**
 * WeCom callback handler.
 *
 * Handles both:
 *  GET  /wecom/callback  – WeCom URL-verification handshake (echostr replay)
 *  POST /wecom/callback  – Encrypted message events
 *
 * Reference: https://developer.work.weixin.qq.com/document/path/90968
 */

'use strict';

const xml2js = require('xml2js');
const { verifySignature, decrypt } = require('./crypto');

const ENCODING_AES_KEY = process.env.WECOM_ENCODING_AES_KEY || '';
const TOKEN = process.env.WECOM_TOKEN || '';

/**
 * Parse an XML string → plain JS object (single-value fields unwrapped).
 * @param {string} xml
 * @returns {Promise<object>}
 */
async function parseXml(xml) {
  const raw = await xml2js.parseStringPromise(xml, { explicitArray: false });
  return raw.xml || raw;
}

/**
 * Handle WeCom GET verification handshake.
 *
 * WeCom sends: GET /wecom/callback?msg_signature=...&timestamp=...&nonce=...&echostr=<encrypted>
 * We must decrypt echostr and return the plaintext.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
function handleHandshake(req, res) {
  const { msg_signature, timestamp, nonce, echostr } = req.query;

  if (!msg_signature || !timestamp || !nonce || !echostr) {
    return res.status(400).send('Missing required query parameters');
  }

  // Verify signature (encryptMsg is the echostr itself for GET handshake)
  if (!verifySignature(TOKEN, timestamp, nonce, echostr, msg_signature)) {
    console.warn('[wecom/callback] Handshake signature verification failed');
    return res.status(403).send('Signature mismatch');
  }

  let plainEchostr;
  try {
    plainEchostr = decrypt(ENCODING_AES_KEY, echostr);
  } catch (err) {
    console.error('[wecom/callback] Failed to decrypt echostr:', err.message);
    return res.status(500).send('Decryption failed');
  }

  console.log('[wecom/callback] Handshake OK');
  return res.status(200).send(plainEchostr);
}

/**
 * Handle WeCom POST message event.
 *
 * Returns the parsed, decrypted message object, or throws on error.
 *
 * @param {import('express').Request} req
 * @returns {Promise<object>} parsed message fields
 */
async function handleMessagePost(req) {
  const { msg_signature, timestamp, nonce } = req.query;

  if (!msg_signature || !timestamp || !nonce) {
    const err = new Error('Missing required query parameters');
    err.status = 400;
    throw err;
  }

  // req.body is the raw XML string (configure express to parse as text)
  const xml = typeof req.body === 'string' ? req.body : req.body.toString();

  let parsed;
  try {
    parsed = await parseXml(xml);
  } catch (e) {
    const err = new Error('Invalid XML body');
    err.status = 400;
    throw err;
  }

  const encryptedMsg = parsed.Encrypt;
  if (!encryptedMsg) {
    // Plain-text mode (no encryption) – allowed in some WeCom configurations
    return parsed;
  }

  // Verify signature
  if (!verifySignature(TOKEN, timestamp, nonce, encryptedMsg, msg_signature)) {
    console.warn('[wecom/callback] POST signature verification failed');
    const err = new Error('Signature mismatch');
    err.status = 403;
    throw err;
  }

  // Decrypt
  let plaintextXml;
  try {
    plaintextXml = decrypt(ENCODING_AES_KEY, encryptedMsg);
  } catch (e) {
    console.error('[wecom/callback] Decrypt error:', e.message);
    const err = new Error('Decryption failed');
    err.status = 500;
    throw err;
  }

  const msg = await parseXml(plaintextXml);
  return msg;
}

module.exports = { handleHandshake, handleMessagePost };

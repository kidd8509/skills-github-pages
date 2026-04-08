/**
 * WeCom message crypto helpers.
 *
 * Implements the WeCom (Weixin Work / 企业微信) official signature
 * verification and AES-256-CBC message encryption / decryption scheme:
 *   https://developer.work.weixin.qq.com/document/path/90968
 *
 * Message decryption overview
 * ─────────────────────────────
 * 1. Base64-decode the EncodingAESKey → 32-byte AES key.
 * 2. The Encrypt field in the callback XML is Base64-encoded ciphertext.
 * 3. Decrypt with AES-256-CBC (IV = first 16 bytes of key).
 * 4. Strip 16-byte random prefix and 4-byte big-endian message length.
 * 5. The remainder is "<appid><plaintext>" – trim the trailing appid.
 *
 * Signature verification
 * ─────────────────────────────
 * SHA1( sort([token, timestamp, nonce, encrypt_msg]).join('') )
 */

'use strict';

const crypto = require('node:crypto');

/**
 * Derive the 32-byte AES key from a WeCom EncodingAESKey (43-char Base64).
 * @param {string} encodingAESKey
 * @returns {Buffer}
 */
function deriveAesKey(encodingAESKey) {
  if (!encodingAESKey || encodingAESKey.length !== 43) {
    throw new Error('EncodingAESKey must be exactly 43 characters');
  }
  return Buffer.from(encodingAESKey + '=', 'base64');
}

/**
 * Verify a WeCom callback signature.
 *
 * @param {string} token         – WECOM_TOKEN from env
 * @param {string} timestamp     – query param
 * @param {string} nonce         – query param
 * @param {string} encryptMsg    – Encrypt field from XML (or empty string for GET handshake)
 * @param {string} msgSignature  – query param msg_signature
 * @returns {boolean}
 */
function verifySignature(token, timestamp, nonce, encryptMsg, msgSignature) {
  const parts = [token, timestamp, nonce, encryptMsg].sort();
  const hash = crypto.createHash('sha1').update(parts.join('')).digest('hex');
  return hash === msgSignature;
}

/**
 * Decrypt a WeCom AES-encrypted message.
 *
 * @param {string} encodingAESKey – 43-char key from WeCom admin
 * @param {string} encryptedMsg   – Base64 ciphertext from the Encrypt XML field
 * @returns {string}              – decrypted plaintext XML/JSON
 */
function decrypt(encodingAESKey, encryptedMsg) {
  const aesKey = deriveAesKey(encodingAESKey);
  const iv = aesKey.slice(0, 16);

  const ciphertext = Buffer.from(encryptedMsg, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  decipher.setAutoPadding(false);

  let decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  // Remove PKCS#7 padding
  const padLen = decrypted[decrypted.length - 1];
  if (padLen > 0 && padLen <= 32) {
    decrypted = decrypted.slice(0, decrypted.length - padLen);
  }

  // Skip 16-byte random prefix
  decrypted = decrypted.slice(16);

  // Read 4-byte big-endian message length
  const msgLen = decrypted.readUInt32BE(0);
  decrypted = decrypted.slice(4);

  // Extract plaintext (message) – the rest after msgLen bytes is the appId
  const plaintext = decrypted.slice(0, msgLen).toString('utf8');
  return plaintext;
}

/**
 * Encrypt a reply message with WeCom AES scheme.
 * (Needed when using the safe-mode callback reply.)
 *
 * @param {string} encodingAESKey
 * @param {string} corpId
 * @param {string} plaintext
 * @returns {string} Base64 ciphertext
 */
function encrypt(encodingAESKey, corpId, plaintext) {
  const aesKey = deriveAesKey(encodingAESKey);
  const iv = aesKey.slice(0, 16);

  const random = crypto.randomBytes(16);
  const msgBuf = Buffer.from(plaintext, 'utf8');
  const corpIdBuf = Buffer.from(corpId, 'utf8');

  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);

  let content = Buffer.concat([random, lenBuf, msgBuf, corpIdBuf]);

  // PKCS#7 padding to 32-byte boundary
  const blockSize = 32;
  const padLen = blockSize - (content.length % blockSize);
  const padding = Buffer.alloc(padLen, padLen);
  content = Buffer.concat([content, padding]);

  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(content), cipher.final()]);
  return encrypted.toString('base64');
}

module.exports = { verifySignature, decrypt, encrypt, deriveAesKey };

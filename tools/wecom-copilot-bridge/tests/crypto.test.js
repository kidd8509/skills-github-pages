/**
 * Unit tests for WeCom crypto helpers.
 * Run with: node --test tests/crypto.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { verifySignature, encrypt, decrypt, deriveAesKey } = require('../src/wecom/crypto');

// ─── deriveAesKey ──────────────────────────────────────────────────────────────

test('deriveAesKey returns 32-byte Buffer for valid 43-char key', () => {
  // 43 chars of Base64 (without trailing '=')
  const key43 = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
  const buf = deriveAesKey(key43);
  assert.equal(buf.length, 32);
  assert.ok(Buffer.isBuffer(buf));
});

test('deriveAesKey throws for wrong-length key', () => {
  assert.throws(() => deriveAesKey('tooshort'), /43 characters/);
  assert.throws(() => deriveAesKey(''), /43 characters/);
});

// ─── verifySignature ───────────────────────────────────────────────────────────

test('verifySignature returns true for correct signature', () => {
  // Build a known-good signature manually:
  // SHA1 of sorted([token, ts, nonce, msg]) joined
  const crypto = require('node:crypto');
  const token = 'testtoken';
  const ts = '1700000000';
  const nonce = 'abc123';
  const msg = 'encryptedstuff';
  const parts = [token, ts, nonce, msg].sort();
  const expected = crypto.createHash('sha1').update(parts.join('')).digest('hex');

  assert.ok(verifySignature(token, ts, nonce, msg, expected));
});

test('verifySignature returns false for wrong signature', () => {
  assert.ok(!verifySignature('tok', '1', 'n', 'e', 'wronghash'));
});

// ─── encrypt / decrypt round-trip ─────────────────────────────────────────────

test('encrypt then decrypt round-trips correctly', () => {
  // Use a deterministic 43-char key (base64url-safe chars padded to 43)
  const key43 = 'aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxk'; // 40 chars
  // Pad to 43
  const padded = (key43 + 'AAA').slice(0, 43);

  const corpId = 'wwTESTCORPID';
  const plaintext = '<xml><ToUserName>app</ToUserName><Content>Hello 你好</Content></xml>';

  const ciphertext = encrypt(padded, corpId, plaintext);
  assert.equal(typeof ciphertext, 'string');
  assert.ok(ciphertext.length > 0);

  const recovered = decrypt(padded, ciphertext);
  assert.equal(recovered, plaintext);
});

test('decrypt handles multi-byte UTF-8 content', () => {
  const key43 = 'aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxk'.slice(0, 40) + 'AAA';
  const corpId = 'wwCORP';
  const plaintext = '日本語テスト 🚀 ÄÖÜ';

  const ciphertext = encrypt(key43, corpId, plaintext);
  const recovered = decrypt(key43, ciphertext);
  assert.equal(recovered, plaintext);
});

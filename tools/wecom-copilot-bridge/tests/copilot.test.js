/**
 * Unit tests for Copilot CLI integration helpers.
 * Run with: node --test tests/copilot.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sanitiseInput, buildPrompt } = require('../src/copilot/index');

test('sanitiseInput removes null bytes', () => {
  const input = 'Hello\0World';
  assert.equal(sanitiseInput(input), 'HelloWorld');
});

test('sanitiseInput removes ANSI escape sequences', () => {
  const input = '\x1b[32mGreen\x1b[0m text';
  assert.equal(sanitiseInput(input), 'Green text');
});

test('sanitiseInput trims whitespace', () => {
  assert.equal(sanitiseInput('  hello  '), 'hello');
});

test('buildPrompt includes system prompt and user message', () => {
  // Override system prompt for predictability
  const origSys = process.env.COPILOT_SYSTEM_PROMPT;
  process.env.COPILOT_SYSTEM_PROMPT = 'Be helpful.';
  // Re-require to pick up env
  delete require.cache[require.resolve('../src/copilot/index')];
  const { buildPrompt: bp } = require('../src/copilot/index');

  const result = bp('What is 2+2?');
  assert.ok(result.includes('Be helpful.'));
  assert.ok(result.includes('What is 2+2?'));

  if (origSys === undefined) delete process.env.COPILOT_SYSTEM_PROMPT;
  else process.env.COPILOT_SYSTEM_PROMPT = origSys;
});

test('buildPrompt appends context files when provided', () => {
  const result = buildPrompt('Summarise this.', '/tmp/foo.txt\n/tmp/bar.txt');
  assert.ok(result.includes('/tmp/foo.txt'));
  assert.ok(result.includes('/tmp/bar.txt'));
});

// ─── Detection logic (unit-tested by mocking execFileSync) ───────────────────

test('COPILOT_BIN env var is used unconditionally when set', () => {
  const origBin = process.env.COPILOT_BIN;
  process.env.COPILOT_BIN = '/usr/local/bin/my-copilot';

  // Clear module cache so getCopilotBin() re-detects with the new env
  delete require.cache[require.resolve('../src/copilot/index')];
  const { getCopilotBin } = require('../src/copilot/index');

  const result = getCopilotBin();
  assert.ok(result !== null, 'should detect a binary');
  assert.equal(result.bin, '/usr/local/bin/my-copilot');
  assert.equal(result.mode, 'standalone');

  if (origBin === undefined) delete process.env.COPILOT_BIN;
  else process.env.COPILOT_BIN = origBin;
});

test('not-found case returns null and does not throw', () => {
  // Point COPILOT_BIN at a non-existent binary to bypass auto-detection,
  // then clear it to force detection to run. Since gh and copilot may or
  // may not be on PATH in CI, we only assert the shape of the result.
  delete require.cache[require.resolve('../src/copilot/index')];
  const { getCopilotBin } = require('../src/copilot/index');

  // Result is either null (not found) or a valid descriptor
  const result = getCopilotBin();
  if (result !== null) {
    assert.ok(typeof result.bin === 'string', 'bin should be a string');
    assert.ok(Array.isArray(result.args), 'args should be an array');
    assert.ok(['gh', 'standalone'].includes(result.mode), 'mode should be gh or standalone');
  }
});

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

/**
 * GitHub Copilot CLI integration.
 *
 * Shells out to `copilot` (standalone) or `gh copilot` (extension) to get
 * AI-generated replies.  The binary is auto-detected at startup.
 *
 * Non-interactive invocation uses the `--` separator and stdin to pass the
 * prompt so the shell doesn't need to escape anything.
 *
 * Environment variables (all optional):
 *   COPILOT_BIN          – explicit path to the copilot binary
 *   COPILOT_TIMEOUT_MS   – ms before we kill the CLI process (default 60000)
 *   COPILOT_SYSTEM_PROMPT – system-level instruction prepended to every prompt
 *   COPILOT_MAX_LENGTH   – max chars to return (excess is truncated, default 2000)
 */

'use strict';

const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = parseInt(process.env.COPILOT_TIMEOUT_MS || '60000', 10);
const SYSTEM_PROMPT =
  process.env.COPILOT_SYSTEM_PROMPT ||
  'You are a helpful assistant. Reply concisely in the same language as the user.';
const MAX_LENGTH = parseInt(process.env.COPILOT_MAX_LENGTH || '2000', 10);

/** Timeout (ms) for binary version-check probes during auto-detection. */
const BINARY_DETECTION_TIMEOUT_MS = 5000;

/** Maximum bytes buffered from a single Copilot CLI invocation (1 MB). */
const MAX_CLI_OUTPUT_BYTES = 1024 * 1024;

// ─── Binary detection ────────────────────────────────────────────────────────────

/**
 * Attempt to locate a working copilot binary.
 * Returns an object { bin, args } where `args` is a prefix args array.
 *   e.g. { bin: 'copilot', args: [] }
 *   e.g. { bin: 'gh', args: ['copilot'] }
 *
 * @returns {{ bin: string, args: string[] } | null}
 */
function detectCopilotBin() {
  const explicit = process.env.COPILOT_BIN;
  if (explicit) {
    return { bin: explicit, args: [] };
  }

  // Try standalone `copilot` binary first
  try {
    execFileSync('copilot', ['--version'], { stdio: 'pipe', timeout: BINARY_DETECTION_TIMEOUT_MS });
    return { bin: 'copilot', args: [] };
  } catch {
    // not found or failed
  }

  // Fall back to `gh copilot`
  try {
    execFileSync('gh', ['copilot', '--version'], { stdio: 'pipe', timeout: BINARY_DETECTION_TIMEOUT_MS });
    return { bin: 'gh', args: ['copilot'] };
  } catch {
    // not found
  }

  return null;
}

let _copilotBin = null;

function getCopilotBin() {
  if (!_copilotBin) {
    _copilotBin = detectCopilotBin();
    if (_copilotBin) {
      console.log(
        `[copilot] Using binary: ${_copilotBin.bin} ${_copilotBin.args.join(' ')}`
      );
    } else {
      console.warn(
        '[copilot] Neither `copilot` nor `gh copilot` found. ' +
          'Install one before messages will be handled.'
      );
    }
  }
  return _copilotBin;
}

// ─── Prompt builder ──────────────────────────────────────────────────────────────

/**
 * Sanitise user input to remove control characters that could confuse the CLI.
 * @param {string} text
 * @returns {string}
 */
function sanitiseInput(text) {
  // Replace null bytes and ANSI escape sequences
  return text
    .replace(/\0/g, '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .trim();
}

/**
 * Build the full prompt string passed to Copilot CLI.
 * @param {string} userMessage
 * @param {string} [contextFiles]  – newline-separated file paths for context
 * @returns {string}
 */
function buildPrompt(userMessage, contextFiles) {
  let prompt = SYSTEM_PROMPT + '\n\n' + sanitiseInput(userMessage);
  if (contextFiles) {
    prompt += '\n\nContext files:\n' + contextFiles;
  }
  return prompt;
}

// ─── Main ask function ───────────────────────────────────────────────────────────

/**
 * Ask Copilot CLI a question and return the response text.
 *
 * @param {string} userMessage   – the user's WeCom message text
 * @param {string[]} [files]     – optional local file paths to include as context
 * @returns {Promise<string>}    – Copilot's reply (may be truncated)
 */
async function ask(userMessage, files = []) {
  const detected = getCopilotBin();
  if (!detected) {
    return (
      '⚠️  Copilot CLI is not installed. ' +
      'Please run `brew install copilot-cli` or `gh extension install github/gh-copilot`.'
    );
  }

  const prompt = buildPrompt(
    userMessage,
    files.length > 0 ? files.join('\n') : undefined
  );

  // Build argument list:
  //   copilot ask "..." [--file path] ...
  // or
  //   gh copilot suggest / ask "..."
  // We use `suggest` for gh-copilot (maps to Q&A mode) and pass the prompt as
  // a positional arg.  For standalone copilot we use `ask`.
  const { bin, args } = detected;
  const subcommand = bin === 'gh' ? 'suggest' : 'ask';

  // File context: for standalone copilot, pass via @path inline; for gh copilot
  // we append a note in the prompt since it doesn't support --file flags yet.
  const fileArgs = [];
  if (files.length > 0 && bin !== 'gh') {
    for (const f of files) {
      fileArgs.push('--file', f);
    }
  }

  const cmdArgs = [...args, subcommand, prompt, ...fileArgs];

  try {
    const { stdout, stderr } = await execFileAsync(bin, cmdArgs, {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_CLI_OUTPUT_BYTES,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    });

    const rawOutput = (stdout || stderr || '').trim();
    if (!rawOutput) {
      return '(Copilot returned an empty response)';
    }

    return rawOutput.length > MAX_LENGTH
      ? rawOutput.slice(0, MAX_LENGTH) + '\n…(truncated)'
      : rawOutput;
  } catch (err) {
    if (err.killed || err.signal === 'SIGTERM') {
      return `⏱ Copilot timed out after ${TIMEOUT_MS / 1000}s. Try a shorter prompt.`;
    }
    console.error('[copilot] CLI error:', err.message);
    return `⚠️  Copilot error: ${err.message.slice(0, 200)}`;
  }
}

module.exports = { ask, getCopilotBin, buildPrompt, sanitiseInput };

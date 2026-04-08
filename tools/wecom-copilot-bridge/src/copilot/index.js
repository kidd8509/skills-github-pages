/**
 * GitHub Copilot CLI integration.
 *
 * Shells out to `gh copilot` (extension, recommended) or a standalone
 * `copilot` binary (GitHub's standalone CLI, if installed) to get AI replies.
 * The binary is auto-detected at startup.
 *
 * IMPORTANT – do NOT confuse these two similarly-named tools:
 *   ✅  GitHub Copilot CLI: installed via `gh extension install github/gh-copilot`
 *                          → invoked as `gh copilot suggest -t shell "<prompt>"`
 *   ❌  AWS Copilot CLI:    installed via `brew install copilot-cli`
 *                          → has `app`/`task` subcommands, NOT `ask`
 *
 * Detection strategy (in priority order):
 *   1. COPILOT_BIN env var  – explicit override, used as-is
 *   2. `gh copilot`         – check via `gh copilot --version`
 *   3. standalone `copilot` – only accepted if `copilot ask --help` exits 0
 *                             (the AWS CLI does NOT have an `ask` subcommand)
 *
 * Environment variables (all optional):
 *   COPILOT_BIN           – explicit path to the copilot binary
 *   COPILOT_TIMEOUT_MS    – ms before we kill the CLI process (default 60000)
 *   COPILOT_SYSTEM_PROMPT – system-level instruction prepended to every prompt
 *   COPILOT_MAX_LENGTH    – max chars to return (excess is truncated, default 2000)
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
 * Attempt to locate a working GitHub Copilot CLI binary.
 * Returns an object { bin, args, mode } where:
 *   bin  – executable name
 *   args – prefix args array (e.g. ['copilot'] for `gh copilot`)
 *   mode – 'gh' | 'standalone'
 *
 * Detection priority:
 *   1. COPILOT_BIN env var  – explicit override, accepted unconditionally
 *   2. `gh copilot`         – GitHub CLI extension (most common install path)
 *   3. standalone `copilot` – only if `copilot ask --help` exits 0 (rules out AWS CLI)
 *
 * @returns {{ bin: string, args: string[], mode: string } | null}
 */
function detectCopilotBin() {
  const explicit = process.env.COPILOT_BIN;
  if (explicit) {
    return { bin: explicit, args: [], mode: 'standalone' };
  }

  // 1. Try `gh copilot` first – this is the official GitHub Copilot CLI path
  //    installed via: gh extension install github/gh-copilot
  try {
    execFileSync('gh', ['copilot', '--version'], {
      stdio: 'pipe',
      timeout: BINARY_DETECTION_TIMEOUT_MS,
    });
    return { bin: 'gh', args: ['copilot'], mode: 'gh' };
  } catch {
    // not installed
  }

  // 2. Try standalone `copilot` binary, but ONLY accept it when the `ask`
  //    subcommand is actually available.  The AWS Copilot CLI (`brew install
  //    copilot-cli`) also ships a `copilot` binary but it has `app`/`task`
  //    commands instead of `ask`, so `copilot ask --help` will exit non-zero.
  try {
    execFileSync('copilot', ['ask', '--help'], {
      stdio: 'pipe',
      timeout: BINARY_DETECTION_TIMEOUT_MS,
    });
    return { bin: 'copilot', args: [], mode: 'standalone' };
  } catch {
    // not found, or it is the AWS Copilot CLI (no `ask` subcommand)
  }

  return null;
}

let _copilotBin = null;

function getCopilotBin() {
  if (!_copilotBin) {
    _copilotBin = detectCopilotBin();
    if (_copilotBin) {
      const label =
        _copilotBin.mode === 'gh'
          ? 'gh copilot (extension)'
          : `${_copilotBin.bin} (standalone)`;
      console.log(`[copilot] Using binary: ${label}`);
    } else {
      console.warn(
        '[copilot] GitHub Copilot CLI not found.\n' +
          '  Recommended install: gh extension install github/gh-copilot\n' +
          '  NOTE: `brew install copilot-cli` installs the AWS Copilot CLI, NOT GitHub Copilot.'
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
      '⚠️  GitHub Copilot CLI is not installed or not detected.\n' +
      'Install it with: gh extension install github/gh-copilot\n' +
      '(Note: `brew install copilot-cli` installs the AWS Copilot CLI, which is different.)'
    );
  }

  const prompt = buildPrompt(
    userMessage,
    files.length > 0 ? files.join('\n') : undefined
  );

  const { bin, args, mode } = detected;

  // Subcommand and extra flags differ by CLI type:
  //   gh copilot suggest -t shell "<prompt>"
  //     `-t shell` avoids the interactive "what kind of command?" prompt.
  //   copilot ask "<prompt>" [--file path ...]
  let subcommand;
  let extraFlags;
  if (mode === 'gh') {
    subcommand = 'suggest';
    // -t shell tells gh-copilot we want a shell command suggestion;
    // without it the CLI asks interactively and hangs in non-interactive mode.
    extraFlags = ['-t', 'shell'];
  } else {
    subcommand = 'ask';
    extraFlags = [];
  }

  // File context: standalone copilot supports --file; gh copilot does not yet.
  const fileArgs = [];
  if (files.length > 0 && mode !== 'gh') {
    for (const f of files) {
      fileArgs.push('--file', f);
    }
  }

  const cmdArgs = [...args, subcommand, ...extraFlags, prompt, ...fileArgs];

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

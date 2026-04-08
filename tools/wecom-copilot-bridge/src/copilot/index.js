/**
 * GitHub Copilot CLI integration.
 *
 * Shells out to `gh copilot` (built-in gh command, v1+) or a standalone
 * `copilot` binary to get AI replies in non-interactive mode.
 * The binary is auto-detected at startup.
 *
 * CLI version compatibility
 * ─────────────────────────
 * GitHub Copilot CLI ≥ 1.0 (current) uses a completely different interface
 * from the old gh extension (which had `suggest`/`ask` subcommands):
 *
 *   ✅  NEW  (v1+): gh copilot -- -p "<prompt>" --allow-all-tools
 *   ❌  OLD (ext):  gh copilot suggest -t shell "<prompt>"   ← removed
 *
 * IMPORTANT – do NOT confuse GitHub Copilot CLI with AWS Copilot CLI:
 *   ✅  GitHub Copilot CLI: installed via `gh` (built-in) or direct download
 *                           → `gh copilot -- -v` prints "GitHub Copilot CLI x.y.z"
 *   ❌  AWS Copilot CLI:    installed via `brew install copilot-cli`
 *                           → has `app`/`task` subcommands, NOT `-p`
 *
 * Detection strategy (in priority order):
 *   1. COPILOT_BIN env var  – explicit path, used as-is (bypasses gh wrapper)
 *   2. `gh copilot`         – check via `gh copilot -- -v`; must print
 *                             "GitHub Copilot CLI" to rule out AWS CLI
 *   3. standalone `copilot` – check via `copilot -v`; must print
 *                             "GitHub Copilot CLI" to rule out AWS CLI
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
 * Run a version probe and return the stdout+stderr output, or null on failure.
 * @param {string} bin
 * @param {string[]} args
 * @returns {string|null}
 */
function probe(bin, args) {
  try {
    return execFileSync(bin, args, {
      stdio: 'pipe',
      timeout: BINARY_DETECTION_TIMEOUT_MS,
      env: { ...process.env, NO_COLOR: '1' },
    }).toString();
  } catch (e) {
    // execFileSync throws on non-zero exit; try stderr if available
    return (e.stderr && e.stderr.toString()) || null;
  }
}

/**
 * Attempt to locate a working GitHub Copilot CLI binary.
 * Returns an object { bin, args, mode } where:
 *   bin  – executable name
 *   args – prefix args array that place us "inside" the copilot scope
 *          e.g. ['copilot', '--'] for `gh copilot -- …`
 *   mode – 'gh' | 'standalone'
 *
 * Detection priority:
 *   1. COPILOT_BIN env var  – explicit override, accepted unconditionally
 *   2. `gh copilot`         – new built-in gh command (v1+); detected via
 *                             `gh copilot -- -v` printing "GitHub Copilot CLI"
 *   3. standalone `copilot` – direct binary; detected via `copilot -v`
 *                             printing "GitHub Copilot CLI" (rules out AWS CLI)
 *
 * @returns {{ bin: string, args: string[], mode: string } | null}
 */
function detectCopilotBin() {
  const explicit = process.env.COPILOT_BIN;
  if (explicit) {
    return { bin: explicit, args: [], mode: 'standalone' };
  }

  // 1. Try `gh copilot` (new built-in, Copilot CLI v1+).
  //    Use `--` to prevent gh from interpreting copilot's flags.
  //    The version string must mention "GitHub Copilot CLI" to distinguish
  //    from the AWS Copilot CLI which also ships a binary named `copilot`.
  const ghVersionOut = probe('gh', ['copilot', '--', '-v']);
  if (ghVersionOut && ghVersionOut.includes('GitHub Copilot CLI')) {
    // Pass ['copilot', '--'] so callers just append copilot flags directly.
    return { bin: 'gh', args: ['copilot', '--'], mode: 'gh' };
  }

  // 2. Try a standalone `copilot` binary (direct install / PATH).
  //    Same version-string check to exclude the AWS CLI.
  const standaloneVersionOut = probe('copilot', ['-v']);
  if (standaloneVersionOut && standaloneVersionOut.includes('GitHub Copilot CLI')) {
    return { bin: 'copilot', args: [], mode: 'standalone' };
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
          ? 'gh copilot (built-in)'
          : `${_copilotBin.bin} (standalone)`;
      console.log(`[copilot] Using binary: ${label}`);
    } else {
      console.warn(
        '[copilot] GitHub Copilot CLI not found.\n' +
          '  Install: gh auth login && gh copilot -- -v   (requires gh v2.54+)\n' +
          '  Or download directly from https://docs.github.com/copilot/how-tos/copilot-cli\n' +
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
      'Make sure `gh` is installed and run: gh auth login\n' +
      'Then verify with: gh copilot -- -v\n' +
      '(Note: `brew install copilot-cli` installs the AWS Copilot CLI, not GitHub Copilot.)'
    );
  }

  const prompt = buildPrompt(
    userMessage,
    files.length > 0 ? files.join('\n') : undefined
  );

  const { bin, args } = detected;

  // New Copilot CLI v1+ interface (no subcommands):
  //   gh copilot -- -p "<prompt>" --allow-all-tools --output-format text
  //   copilot    -- -p "<prompt>" --allow-all-tools --output-format text
  //
  // --allow-all-tools is required for non-interactive mode (no TTY).
  // --output-format text gives plain text output (no JSONL lines).
  // The `--` separator (already included in args for 'gh' mode) prevents
  // the gh wrapper from intercepting copilot-specific flags.
  const promptFlags = ['-p', prompt, '--allow-all-tools', '--output-format', 'text'];

  const cmdArgs = [...args, ...promptFlags];

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

/**
 * GitHub Copilot CLI integration.
 *
 * Shells out to the standalone `copilot` binary (GitHub Copilot CLI) or,
 * as a fallback, a `gh copilot` wrapper to get AI replies in non-interactive
 * mode.  The binary is auto-detected at startup.
 *
 * Installing the GitHub Copilot CLI
 * ──────────────────────────────────
 *   npm install -g @github/copilot      ← recommended (cross-platform)
 *   curl -fsSL https://gh.io/copilot-install | bash
 *
 * Non-interactive interface (what this bridge uses):
 *   copilot -s -p "<prompt>"
 *   │          │   └── your question / instruction
 *   │          └────── silent: output only Copilot's response text
 *   └───────────────── the GitHub Copilot CLI standalone binary
 *
 * IMPORTANT – do NOT confuse GitHub Copilot CLI with AWS Copilot CLI:
 *   ✅  GitHub Copilot CLI: `npm install -g @github/copilot`
 *                           → `copilot version` prints "GitHub Copilot …"
 *   ❌  AWS Copilot CLI:    `brew install copilot-cli` (Homebrew formula)
 *                           → `copilot --version` prints "copilot version: vX.Y.Z"
 *                           → has `app`/`svc`/`task` subcommands, NOT `-p`
 *   ❌  OLD gh extension:   `gh copilot suggest -t shell "…"` – deprecated Oct 2025
 *
 * Detection strategy (in priority order):
 *   1. COPILOT_BIN env var  – explicit path, used as-is (bypasses auto-detect)
 *   2. standalone `copilot` – check via `copilot version`; output must contain
 *                             "GitHub Copilot" to rule out the AWS CLI
 *   3. `gh copilot`         – legacy/fallback; check via `gh copilot -- version`
 *                             or `gh copilot -- -v`; same "GitHub Copilot" guard
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
 *   2. standalone `copilot` – preferred; detected via `copilot version`
 *                             (the documented subcommand).  Output must contain
 *                             "GitHub Copilot" to rule out the AWS Copilot CLI
 *                             (which prints "copilot version: vX.Y.Z").
 *   3. `gh copilot`         – legacy fallback; detected via
 *                             `gh copilot -- version` or `gh copilot -- -v`.
 *
 * @returns {{ bin: string, args: string[], mode: string } | null}
 */
function detectCopilotBin() {
  const explicit = process.env.COPILOT_BIN;
  if (explicit) {
    return { bin: explicit, args: [], mode: 'standalone' };
  }

  // 1. Standalone `copilot` binary (GitHub Copilot CLI direct install).
  //    Use `copilot version` – the documented subcommand for version info.
  //    Fall back to `--version` / `-v` for older or alternative builds.
  //    The output must contain "GitHub Copilot" to distinguish from the
  //    AWS Copilot CLI (aws/copilot-cli), which also ships a binary called
  //    `copilot` and prints "copilot version: vX.Y.Z" (no "GitHub" prefix).
  const standaloneOut =
    probe('copilot', ['version']) ||
    probe('copilot', ['--version']) ||
    probe('copilot', ['-v']);
  if (standaloneOut && standaloneOut.includes('GitHub Copilot')) {
    return { bin: 'copilot', args: [], mode: 'standalone' };
  }

  // 2. `gh copilot` wrapper – legacy / fallback path.
  //    Tries the documented `version` subcommand first, then `-v`.
  //    Same "GitHub Copilot" guard to reject any non-GitHub binary.
  const ghOut =
    probe('gh', ['copilot', '--', 'version']) ||
    probe('gh', ['copilot', '--', '-v']);
  if (ghOut && ghOut.includes('GitHub Copilot')) {
    return { bin: 'gh', args: ['copilot', '--'], mode: 'gh' };
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
          '  Install: npm install -g @github/copilot\n' +
          '  Or:      curl -fsSL https://gh.io/copilot-install | bash\n' +
          '  Verify:  copilot version   (should print "GitHub Copilot …")\n' +
          '  NOTE: `brew install copilot-cli` (Homebrew formula) installs the AWS Copilot CLI,\n' +
          '        NOT GitHub Copilot.  Use the npm package or install script instead.'
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
      'Install: npm install -g @github/copilot\n' +
      'Or:      curl -fsSL https://gh.io/copilot-install | bash\n' +
      'Verify:  copilot version\n' +
      '(Note: `brew install copilot-cli` via Homebrew formula installs the AWS Copilot CLI, not GitHub Copilot.)'
    );
  }

  const prompt = buildPrompt(
    userMessage,
    files.length > 0 ? files.join('\n') : undefined
  );

  const { bin, args } = detected;

  // GitHub Copilot CLI non-interactive interface:
  //   copilot -s -p "<prompt>"          (standalone)
  //   gh copilot -- -s -p "<prompt>"    (via gh wrapper, mode='gh')
  //
  // -s / --silent  Output only Copilot's response text, omitting usage info
  //                and decorations.  Ideal for piping / bridge automation.
  // -p / --prompt  Non-interactive prompt; required for headless operation.
  //
  // NOTE: the old gh-copilot extension flags (--allow-all-tools,
  //       --output-format text) are NOT valid for the current standalone CLI.
  const promptFlags = ['-s', '-p', prompt];

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

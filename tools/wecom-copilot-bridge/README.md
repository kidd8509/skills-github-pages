# WeCom ↔ GitHub Copilot CLI Bridge

A local service (Node.js) that bridges **WeCom (企业微信)** messages to **GitHub Copilot CLI**, letting you chat with Copilot directly from any WeCom group or DM.

```
WeCom user ──► WeCom servers ──► (ngrok / public URL)
                                      │
                              POST /wecom/callback
                                      │
                              ┌───────▼────────┐
                              │  bridge server  │
                              │  (Node.js)      │
                              │   ├─ verify sig  │
                              │   ├─ decrypt XML │
                              │   ├─ copilot ask │
                              │   └─ send reply  │
                              └────────────────┘
                                      │
                     ┌────────────────┴──────────────────┐
              Group Robot Webhook                  App API (DM)
```

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Install](#2-install)
3. [Configure env vars](#3-configure-env-vars)
4. [WeCom setup](#4-wecom-setup)
   - [Group Robot (groups)](#41-group-robot-groups)
   - [WeCom App + callback (DMs + groups)](#42-wecom-app--callback-dms--groups)
5. [Expose the local server](#5-expose-the-local-server-ngrok)
6. [Run locally](#6-run-locally)
7. [Test with curl](#7-test-with-curl)
8. [File exchange](#8-file-exchange)
9. [Optional: WebSocket inbound client](#9-optional-websocket-inbound-client)
10. [Security notes](#10-security-notes)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Prerequisites

| Requirement | Install |
|---|---|
| **Node.js ≥ 18** | `brew install node` |
| **GitHub CLI ≥ 2.54** | `brew install gh` |
| **ngrok** (for public URL) | `brew install ngrok/ngrok/ngrok` |
| A **WeCom developer account** with an enterprise (corp) | [work.weixin.qq.com](https://work.weixin.qq.com) |

GitHub Copilot CLI is now built into `gh` (v2.54+) — no separate extension needed.

> ⚠️ **Common mistake**: `brew install copilot-cli` installs the **AWS Copilot CLI**
> (used for deploying containers to AWS), **not** the GitHub Copilot CLI.
> The AWS CLI uses subcommands like `app` and `task` — it will not work with this bridge.

Set up GitHub Copilot CLI:

```bash
brew install gh              # GitHub CLI (if not already installed, or run: brew upgrade gh)
gh auth login                # authenticate with your GitHub account
gh copilot -- -v             # should print: GitHub Copilot CLI x.y.z
```

Verify it works in non-interactive mode (what the bridge uses):

```bash
gh copilot -- -p "What is 2+2?" --allow-all-tools
```

---

## 2. Install

```bash
cd tools/wecom-copilot-bridge
npm install
```

---

## 3. Configure env vars

```bash
cp .env.example .env
```

Edit `.env` – all available variables are documented in `.env.example`.

Minimum required variables:

| Variable | Purpose |
|---|---|
| `WECOM_TOKEN` | WeCom callback token (from app settings) |
| `WECOM_ENCODING_AES_KEY` | 43-char AES key (from app settings) |
| `WECOM_CORP_ID` | Your enterprise CorpID |
| `WECOM_AGENT_ID` | Your app's AgentID |
| `WECOM_APP_SECRET` | Your app's Secret |
| `WECOM_GROUP_ROBOT_WEBHOOK` | Group robot webhook URL (for group replies) |

---

## 4. WeCom setup

### 4.1 Group Robot (groups)

The simplest path – only requires a group robot to post into a WeCom group.

1. Open the WeCom group you want the bot in.
2. Click **"…"** → **"Add Group Robot"** → give it a name.
3. Copy the **Webhook URL** → paste into `.env` as `WECOM_GROUP_ROBOT_WEBHOOK`.

> **Note**: Group Robot can only *post* to the group. To also *receive* messages from the group you need the WeCom App callback below.

### 4.2 WeCom App + callback (DMs + groups)

1. Log in to [work.weixin.qq.com](https://work.weixin.qq.com) as an admin.
2. Go to **Apps & Integrations → Create a Custom App**.
3. Fill in the name and upload an icon. Note down:
   - **CorpID** (on the company page) → `WECOM_CORP_ID`
   - **AgentID** (on the app page) → `WECOM_AGENT_ID`
   - **App Secret** → `WECOM_APP_SECRET`
4. Under **"Receive Messages"** → turn it on → click **"Set URL"**.
   - **URL**: `https://<your-ngrok-host>/wecom/callback`
   - **Token**: generate a random string → `WECOM_TOKEN`
   - **EncodingAESKey**: click **"Random"** → copy 43-char value → `WECOM_ENCODING_AES_KEY`
   - **Message Encryption Mode**: choose **Safe Mode** (AES encrypted, recommended).
5. Click **Save** – WeCom will immediately make a GET request to your URL to verify the signature and echostr. Your server must be running and publicly reachable at this point.

---

## 5. Expose the local server (ngrok)

```bash
# In a separate terminal
ngrok http 3000
```

Copy the `https://xxxx.ngrok.io` URL. Use it as your callback base URL in WeCom admin.

> On macOS, `ngrok` keeps running as long as the terminal is open. For always-on use without a paid ngrok plan, keep the terminal open in a `tmux` or `screen` session, or create a launchd plist:
>
> ```bash
> # Example: keep ngrok running via launchd (adapt the path as needed)
> # Place in ~/Library/LaunchAgents/com.wecom.bridge.ngrok.plist
> # Then: launchctl load ~/Library/LaunchAgents/com.wecom.bridge.ngrok.plist
> ```
>
> Alternatively, use [localtunnel](https://localtunnel.github.io) (`npx localtunnel --port 3000`) as a free alternative.

---

## 6. Run locally

```bash
# Development (auto-restart on file changes, Node ≥ 18)
npm run dev

# Production
npm start
```

Expected output:

```
[bridge] Loaded .env
[copilot] Using binary: copilot
[bridge] Listening on http://localhost:3000
[bridge] WeCom callback: POST /wecom/callback
[bridge] Health check:   GET  /health
```

---

## 7. Test with curl

### 7.1 Health check

```bash
curl http://localhost:3000/health
# → {"status":"ok"}
```

### 7.2 Simulate WeCom GET handshake

```bash
# Replace values with what your WeCom admin console shows during verification
curl "http://localhost:3000/wecom/callback?msg_signature=XXXX&timestamp=1700000000&nonce=abc&echostr=ENCRYPTED_ECHOSTR"
```

### 7.3 Simulate a plain-text WeCom POST message (no encryption)

> Only works if your WeCom app is set to **Plaintext mode** (not recommended for production).

```bash
curl -X POST http://localhost:3000/wecom/callback \
  -H "Content-Type: text/xml" \
  -d '<?xml version="1.0"?>
<xml>
  <ToUserName><![CDATA[ww_your_app_id]]></ToUserName>
  <FromUserName><![CDATA[your_userid]]></FromUserName>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[What is the capital of France?]]></Content>
  <MsgId>1234567890</MsgId>
</xml>'
```

Watch the server logs – you should see Copilot's response and the reply being dispatched.

### 7.4 Send a test message via Group Robot

```bash
curl -X POST "$WECOM_GROUP_ROBOT_WEBHOOK" \
  -H "Content-Type: application/json" \
  -d '{"msgtype":"text","text":{"content":"Hello from the bridge test!"}}'
```

---

## 8. File exchange

### Receiving files from WeCom

When a user sends an image/file/voice message to the WeCom app, the bridge will:

1. Receive the callback with a `media_id` field.
2. Call the WeCom `media/get` API to download the file.
3. Save it to `INBOX_DIR` (default `./inbox/`).
4. Pass the local file path to Copilot CLI and ask it to summarise/describe.

### Sending files back

Place a file in `OUTBOX_DIR` (default `./outbox/`) and use the programmatic API:

```js
const { sendGroupRobotFile } = require('./src/wecom/sender');
await sendGroupRobotFile('./outbox/report.pdf');
```

Or extend the routes to accept an HTTP command, for example:

```bash
# Trigger a file send via a curl command to a custom endpoint you add
curl -X POST http://localhost:3000/send-file \
  -H "Content-Type: application/json" \
  -d '{"file":"./outbox/report.pdf"}'
```

---

## 9. Optional: WebSocket inbound client

Some unofficial WeCom desktop plugins expose a local WebSocket that delivers messages without needing a public callback URL.

Enable it by adding to `.env`:

```
ENABLE_WS_CLIENT=true
WS_URL=ws://127.0.0.1:8888/ws
WS_AUTH_TOKEN=optional_token
```

The client will:
1. Connect (and auto-reconnect on disconnect).
2. Optionally send an auth token as the first message.
3. Parse each incoming JSON event and route it through the same Copilot reply pipeline.

Adapt `src/ws/client.js` → `parseEvent()` to match your plugin's exact JSON schema.

---

## 10. Security notes

- **Never commit `.env`** – it is already in `.gitignore`.
- **Always validate signatures** – the bridge verifies WeCom's HMAC-SHA1 signature on every callback. Do not disable this check.
- **Rotate your EncodingAESKey and Token** if you suspect they've been exposed.
- **Use HTTPS** for the public-facing endpoint (ngrok provides this automatically).
- **Restrict access** – consider adding IP allowlisting for WeCom's IP ranges in your firewall/ngrok config.
- **Copilot CLI credentials** are stored in `~/.config/github-copilot/` – ensure the machine is physically secure.
- The WebSocket client feature is **unofficial** and may break with WeCom plugin updates. Use the official callback path for production.

---

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `unknown command "ask" for "copilot"` | **AWS Copilot CLI** is installed instead of GitHub Copilot | `brew install copilot-cli` installs the AWS CLI. Use `gh` instead (see Prerequisites) |
| `unknown command "suggest" for "copilot"` | **Old** `gh copilot` extension (pre-v1) installed | Remove old extension: `gh extension remove copilot`; upgrade gh: `brew upgrade gh` |
| `GitHub Copilot CLI not found` in server logs | `gh copilot -- -v` doesn't print "GitHub Copilot CLI" | Run `brew upgrade gh` then `gh auth login` and restart the bridge |
| `403 Signature mismatch` on handshake | Wrong `WECOM_TOKEN` or `WECOM_ENCODING_AES_KEY` | Copy the values exactly from WeCom admin |
| `Decryption failed` | Wrong `WECOM_ENCODING_AES_KEY` (must be exactly 43 chars) | Re-copy the key; don't add `=` padding |
| WeCom keeps retrying the callback | Server returned non-200 or took > 5 s | The bridge always returns 200 immediately; check logs for crash |
| `WECOM_GROUP_ROBOT_WEBHOOK is not configured` | Env var missing | Add it to `.env` |
| `gettoken error` | Wrong `WECOM_CORP_ID` or `WECOM_APP_SECRET` | Verify in WeCom admin console |

### How to identify your installed CLI

```bash
# GitHub Copilot CLI (correct) – prints "GitHub Copilot CLI x.y.z"
gh copilot -- -v

# AWS Copilot CLI (wrong for this bridge) – lists app/deploy/svc commands
copilot --help | head -5
```

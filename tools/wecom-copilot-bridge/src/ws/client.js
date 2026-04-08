/**
 * Optional WebSocket inbound client.
 *
 * Connects to an unofficial WeCom plugin WebSocket to receive messages
 * locally, then routes them through the same handler used by the
 * official HTTP callback endpoint.
 *
 * Enable by setting the environment variable:
 *   ENABLE_WS_CLIENT=true
 *
 * Configure:
 *   WS_URL=ws://127.0.0.1:8888/ws
 *   WS_AUTH_TOKEN=<optional first-message auth token>
 *
 * The plugin is expected to send JSON events in the shape:
 *   {
 *     type: "message",
 *     fromUser: "userid",
 *     fromGroup: "groupid",   // present for group messages
 *     content: "hello",
 *     msgType: "text",        // text | image | file | voice | ...
 *     mediaId: "...",         // optional, for file/image/voice
 *   }
 *
 * If the shape differs, adapt the parseEvent() function below.
 */

'use strict';

let WebSocket;
try {
  // Node 22+ has WebSocket built-in; for older versions require 'ws'
  WebSocket = globalThis.WebSocket ?? require('ws');
} catch {
  WebSocket = null;
}

const ENABLED = process.env.ENABLE_WS_CLIENT === 'true';
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8888/ws';
const WS_AUTH_TOKEN = process.env.WS_AUTH_TOKEN || '';

const RECONNECT_DELAY_MS = parseInt(
  process.env.WS_RECONNECT_DELAY_MS || '5000',
  10
);

/**
 * Normalise a WS plugin event into the same shape as a WeCom callback message.
 * Adapt this function to match your plugin's actual JSON schema.
 *
 * @param {object} event
 * @returns {{ fromUser: string, fromGroup?: string, content: string, msgType: string, mediaId?: string } | null}
 */
function parseEvent(event) {
  if (!event || event.type !== 'message') return null;
  return {
    fromUser: event.fromUser || event.from_user || 'unknown',
    fromGroup: event.fromGroup || event.from_group || undefined,
    content: event.content || event.text || '',
    msgType: (event.msgType || event.msg_type || 'text').toLowerCase(),
    mediaId: event.mediaId || event.media_id || undefined,
  };
}

/**
 * Start the WebSocket client.
 *
 * @param {function(object): Promise<void>} onMessage
 *   Async callback invoked for each parsed inbound message.
 *   Receives the same normalised object returned by parseEvent().
 */
function startWsClient(onMessage) {
  if (!ENABLED) {
    console.log('[ws-client] Disabled (set ENABLE_WS_CLIENT=true to enable)');
    return;
  }
  if (!WebSocket) {
    console.warn(
      '[ws-client] WebSocket is not available. ' +
        'On Node <22 run: npm install ws'
    );
    return;
  }

  let ws;

  function connect() {
    console.log(`[ws-client] Connecting to ${WS_URL} …`);
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
      console.log('[ws-client] Connected');
      if (WS_AUTH_TOKEN) {
        ws.send(JSON.stringify({ type: 'auth', token: WS_AUTH_TOKEN }));
      }
    });

    ws.on('message', async (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        console.warn('[ws-client] Received non-JSON message, ignoring');
        return;
      }
      const msg = parseEvent(event);
      if (!msg) return;

      try {
        await onMessage(msg);
      } catch (err) {
        console.error('[ws-client] onMessage handler error:', err.message);
      }
    });

    ws.on('error', (err) => {
      console.error('[ws-client] Error:', err.message);
    });

    ws.on('close', (code) => {
      console.warn(
        `[ws-client] Connection closed (code ${code}). Reconnecting in ${RECONNECT_DELAY_MS / 1000}s …`
      );
      setTimeout(connect, RECONNECT_DELAY_MS);
    });
  }

  connect();
}

module.exports = { startWsClient, parseEvent };

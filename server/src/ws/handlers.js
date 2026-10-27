/**
 * StreamSync - WebSocket Message Handlers
 * Handles all inbound WS events from peers: party sync, chat, typing.
 */

import {
  getRoom,
  updateSync,
  updateVideo,
  broadcast,
  roomSnapshot,
} from '../core/registry.js';

/**
 * Route an inbound WebSocket message from a peer.
 * @param {string} party_id
 * @param {string} conn_id
 * @param {{ id: string, display_name: string, is_owner: boolean }} user
 * @param {import('ws').WebSocket} ws
 * @param {string} raw - Raw JSON string from client
 */
export function handleMessage(party_id, conn_id, user, ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    ws.send(JSON.stringify({ type: 'error', code: 'INVALID_JSON' }));
    return;
  }

  switch (msg.type) {
    case 'ping':
      // NTP clock calibration response
      handlePing(ws, msg);
      break;

    case 'party':
      handlePartyUpdate(party_id, conn_id, user, ws, msg);
      break;

    case 'chat':
      handleChat(party_id, conn_id, user, msg);
      break;

    case 'typing':
      handleTyping(party_id, conn_id, user, msg);
      break;

    default:
      ws.send(JSON.stringify({ type: 'error', code: 'UNKNOWN_TYPE', received: msg.type }));
  }
}

/**
 * NTP Ping: client sends t0, server echoes t0 + server's current epoch ms.
 * Client formula: offset θ = server_time + (RTT/2) - t3
 * @param {import('ws').WebSocket} ws
 * @param {{ client_time: number }} msg
 */
function handlePing(ws, msg) {
  ws.send(JSON.stringify({
    type: 'pong',
    client_time: msg.client_time,     // echo t0 back untouched
    server_time: Date.now(),          // t1 — server epoch ms
  }));
}

/**
 * Party sync/video update event.
 * Validates permissions (shared_controls), updates room state, then
 * broadcasts the updated state to all other peers.
 */
function handlePartyUpdate(party_id, conn_id, user, ws, msg) {
  const room = getRoom(party_id);
  if (!room) {
    ws.send(JSON.stringify({ type: 'error', code: 'ROOM_NOT_FOUND' }));
    return;
  }

  // Permission check: if shared_controls is false, only the creator can mutate sync
  if (!room.shared_controls && !user.is_owner) {
    ws.send(JSON.stringify({ type: 'error', code: 'PERMISSION_DENIED' }));
    return;
  }

  const payload = msg.party || msg;

  // Persist browsing state changes
  if (payload.browsing !== undefined) {
    room.browsing = !!payload.browsing;
  }

  // Persist sync state changes
  if (payload.sync) {
    updateSync(party_id, {
      started: payload.sync.started ?? room.sync.started,
      paused:  payload.sync.paused  ?? null,
    });
  }

  // Persist video changes (host switching content)
  if (payload.video) {
    updateVideo(party_id, payload.video);
  }

  if (payload.settings?.shared_controls !== undefined && user.is_owner) {
    room.shared_controls = !!payload.settings.shared_controls;
  }

  // Broadcast the mutation to all peers INCLUDING sender so their state confirms
  broadcast(party_id, {
    type: 'party',
    ...roomSnapshot(room),
    sender_id: user.id,
  });
}

/**
 * Chat message event. Fans out to all room peers including sender.
 */
function handleChat(party_id, conn_id, user, msg) {
  if (!msg.content || typeof msg.content !== 'string') return;
  const content = msg.content.slice(0, 500).trim(); // max 500 chars
  if (!content) return;

  broadcast(party_id, {
    type: 'chat',
    id: `msg_${Date.now()}_${conn_id.slice(-4)}`,
    user_id: user.id,
    display_name: user.display_name,
    content,
    created_at: Date.now(),
  });
}

/**
 * Typing indicator. Fans out to all room peers EXCEPT the sender.
 */
function handleTyping(party_id, conn_id, user, msg) {
  broadcast(party_id, {
    type: 'typing',
    user_id: user.id,
    display_name: user.display_name,
    is_typing: !!msg.is_typing,
  }, conn_id /* exclude sender */);
}

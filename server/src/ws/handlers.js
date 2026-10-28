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
  // 1MB pre-parse message size guard to prevent CPU exhaustion on massive payloads
  if (raw && raw.length > 1_048_576) {
    ws.send(JSON.stringify({ type: 'error', error: 'Message too large' }));
    return;
  }

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
      handleChat(party_id, conn_id, user, ws, msg);
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

  // Persist video changes (host switching content) first so room resets if new video
  if (payload.video) {
    updateVideo(party_id, payload.video);
  }

  // Persist synchronized subtitle and audio tracks
  if (payload.tracks) {
    if (!room.tracks) room.tracks = { subtitle: null, audio: null };
    if (payload.tracks.subtitle !== undefined) {
      room.tracks.subtitle = payload.tracks.subtitle;
    }
    if (payload.tracks.audio !== undefined) {
      room.tracks.audio = payload.tracks.audio;
    }
  }

  // Persist sync state changes
  if (payload.sync) {
    const isPaused = payload.sync.status === 'PAUS' || (payload.sync.paused !== null && payload.sync.paused !== undefined);
    const pos = payload.sync.position !== undefined ? payload.sync.position : (payload.sync.paused !== null && payload.sync.paused !== undefined ? payload.sync.paused : room.sync.position);

    updateSync(party_id, {
      status:   payload.sync.status ?? (isPaused ? 'PAUS' : 'PLAY'),
      position: pos,
      time:     payload.sync.time ?? Date.now(),
      started:  payload.sync.started !== undefined ? payload.sync.started : (isPaused ? null : room.sync.started),
      paused:   isPaused ? pos : null,
      rate:     payload.sync.rate ?? room.sync.rate ?? 1.0,
    });
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
 * Handles both rich Phase 2 ChatMessage and legacy string formats.
 */
function handleChat(party_id, conn_id, user, ws, msg) {
  const serialized = JSON.stringify(msg);
  if (serialized.length > 1_048_576) {
    ws.send(JSON.stringify({ type: 'error', error: 'Message too large' }));
    return;
  }

  // Support extended rich ChatMessage schema
  if (msg.chat && typeof msg.chat === 'object') {
    const chatPayload = {
      id: msg.chat.id || `msg_${Date.now()}_${conn_id.slice(-4)}`,
      user: msg.chat.user || { id: user.id, name: user.display_name },
      type: msg.chat.type || 'text',
      text: msg.chat.text,
      stickerId: msg.chat.stickerId,
      gifUrl: msg.chat.gifUrl,
      attachment: msg.chat.attachment,
      replyTo: msg.chat.replyTo,
      timestamp: msg.chat.timestamp || Date.now(),
    };

    console.log({ room: party_id, type: chatPayload.type, user: chatPayload.user?.id || user.id });

    broadcast(party_id, {
      type: 'chat',
      chat: chatPayload,
      // Provide legacy fields for backwards compatibility with any basic observers
      id: chatPayload.id,
      user_id: user.id,
      display_name: user.display_name,
      content: chatPayload.text || `[${chatPayload.type}]`,
      created_at: chatPayload.timestamp,
    });
    return;
  }

  // Legacy string format fallback
  if (msg.content && typeof msg.content === 'string') {
    const content = msg.content.slice(0, 500).trim();
    if (!content) return;

    const legacyId = `msg_${Date.now()}_${conn_id.slice(-4)}`;
    console.log({ room: party_id, type: 'text', user: user.id });

    broadcast(party_id, {
      type: 'chat',
      id: legacyId,
      user_id: user.id,
      display_name: user.display_name,
      content,
      created_at: Date.now(),
      chat: {
        id: legacyId,
        user: { id: user.id, name: user.display_name },
        type: 'text',
        text: content,
        timestamp: Date.now(),
      },
    });
  }
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

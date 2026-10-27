/**
 * StreamSync - WebSocket Server
 * RFC 6455 raw WebSocket. No Socket.IO.
 * Handles connection lifecycle: auth, room join, presence, disconnect.
 *
 * WS Upgrade URL format:
 *   ws://localhost:3001/ws?party_id=<id>&user_id=<id>&display_name=<name>
 */

import { nanoid } from 'nanoid';
import {
  getRoom,
  addPeer,
  removePeer,
  broadcast,
  roomSnapshot,
} from '../core/registry.js';
import { handleMessage } from './handlers.js';

/**
 * Register the WebSocket route on the Fastify instance.
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function registerWsServer(fastify) {
  fastify.get('/ws', { websocket: true }, (socket, request) => {
    const { party_id, user_id, display_name } = request.query;

    // ── Validate query params ──────────────────────────────────────────────
    if (!party_id || !user_id || !display_name) {
      socket.send(JSON.stringify({
        type: 'error',
        code: 'MISSING_PARAMS',
        message: 'Required: party_id, user_id, display_name',
      }));
      socket.close(4000, 'Missing params');
      return;
    }

    const room = getRoom(party_id);
    if (!room) {
      socket.send(JSON.stringify({
        type: 'error',
        code: 'ROOM_NOT_FOUND',
        message: `No room found for id: ${party_id}`,
      }));
      socket.close(4004, 'Room not found');
      return;
    }

    // ── Assign connection ID and peer info ────────────────────────────────
    const conn_id = `conn_${nanoid(8)}`;
    const is_owner = user_id === room.creator_id;

    const user = {
      id: user_id,
      display_name: decodeURIComponent(display_name),
      is_owner,
    };

    addPeer(room.party_id, conn_id, socket, user);

    console.log(`[WS] ${user.display_name} joined ${room.short_id} (${room.party_id}) conn=${conn_id}`);

    // ── Send initial room state to newly connected peer ───────────────────
    socket.send(JSON.stringify({
      type: 'party',
      ...roomSnapshot(room),
    }));

    // Announce the updated user list to ALL peers
    broadcast(room.party_id, {
      type: 'users',
      users: roomSnapshot(room).users,
    });

    // ── Message routing ────────────────────────────────────────────────────
    socket.on('message', (rawBuffer) => {
      const raw = rawBuffer.toString();
      handleMessage(room.party_id, conn_id, user, socket, raw);
    });

    // ── Disconnect cleanup ─────────────────────────────────────────────────
    socket.on('close', (code, reason) => {
      removePeer(room.party_id, conn_id);
      console.log(`[WS] ${user.display_name} left ${room.short_id} conn=${conn_id} code=${code}`);

      const updatedRoom = getRoom(room.party_id);
      if (updatedRoom) {
        broadcast(room.party_id, {
          type: 'users',
          users: roomSnapshot(updatedRoom).users,
        });
      }
    });

    socket.on('error', (err) => {
      console.error(`[WS] Error conn=${conn_id}:`, err.message);
      removePeer(room.party_id, conn_id);
    });
  });
}

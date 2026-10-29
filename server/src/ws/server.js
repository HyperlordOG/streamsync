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
  getRoomUsers,
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

    // Attach explicit socket IDs and user metadata for multi-device support
    socket.socketId = conn_id;
    socket.userId = user_id;
    socket.displayName = user.display_name;

    addPeer(room.party_id, conn_id, socket, user);

    console.log(`[WS] ${user.display_name} joined ${room.short_id} (${room.party_id}) conn=${conn_id}`);

    // ── Send initial room state to newly connected peer ───────────────────
    socket.send(JSON.stringify({
      type: 'party',
      ...roomSnapshot(room),
    }));

    // Announce the updated user list to ALL peers (deduplicated users + connectionCount)
    const initialUsers = getRoomUsers(room);
    broadcast(room.party_id, {
      type: 'users',
      users: initialUsers.users,
      connectionCount: initialUsers.connectionCount,
      host_id: room.creator_id,
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
        // Host failover logic:
        // if the host's socket disconnects but they have another device still connected in the same room,
        // do NOT transfer host status — check if any remaining connection has the same userId as the departing host
        // before electing a new host.
        if (user.id === updatedRoom.creator_id) {
          const hasAnotherDevice = Array.from(updatedRoom.peers.values()).some(
            ({ user: u }) => u.id === updatedRoom.creator_id
          );
          if (!hasAnotherDevice && updatedRoom.peers.size > 0) {
            const nextHostUser = updatedRoom.peers.values().next().value.user;
            updatedRoom.creator_id = nextHostUser.id;
            console.log(`[WS] Host failover: transferred host status to ${nextHostUser.display_name} (${nextHostUser.id})`);
            updatedRoom.peers.forEach((peer) => {
              peer.user.is_owner = (peer.user.id === updatedRoom.creator_id);
            });
            broadcast(room.party_id, {
              type: 'party',
              ...roomSnapshot(updatedRoom),
            });
          }
        }

        const roomUsers = getRoomUsers(updatedRoom);
        broadcast(room.party_id, {
          type: 'users',
          users: roomUsers.users,
          connectionCount: roomUsers.connectionCount,
          host_id: updatedRoom.creator_id,
        });
      }
    });

    socket.on('error', (err) => {
      console.error(`[WS] Error conn=${conn_id}:`, err.message);
      removePeer(room.party_id, conn_id);
    });
  });
}

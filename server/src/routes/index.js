/**
 * StreamSync - REST Routes
 * POST /api/join          -> Create a new watch party room
 * POST /api/join/:id      -> Join an existing room by short_id or party_id
 * POST /api/party/:id     -> Update video / sync / settings via REST (fallback)
 */

import { nanoid } from 'nanoid';
import {
  createRoom,
  getRoom,
  updateSync,
  updateVideo,
  roomSnapshot,
} from '../core/registry.js';
import mediaRoutes from './media.js';
import chatRoutes from './chat.js';

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function registerRoutes(fastify) {
  // Register Streamo Streaming & TMDB Media Routes
  await fastify.register(mediaRoutes, { prefix: '/api/media' });

  // Register Rich Chat Routes (Stickers & Tenor GIF Proxies)
  await fastify.register(chatRoutes, { prefix: '/api/chat' });


  // ── POST /api/join  (Create Room) ────────────────────────────────────────
  fastify.post('/api/join', {
    schema: {
      body: {
        type: 'object',
        required: ['display_name'],
        properties: {
          user_id:        { type: 'string' },
          display_name:   { type: 'string' },
          shared_controls:{ type: 'boolean' },
          video: {
            type: 'object',
            properties: {
              url:       { type: 'string' },
              provider:  { type: 'string', enum: ['mp4', 'hls', 'youtube', 'dash', 'netflix', 'prime', 'streamo'] },
              title:     { type: 'string' },
              thumbnail: { type: 'string' },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { display_name, shared_controls = true, video } = request.body;
    const user_id = request.body.user_id || `u_${nanoid(8)}`;

    const room = createRoom({ creator_id: user_id, display_name, shared_controls, video });

    console.log(`[REST] Room created: ${room.short_id} by ${display_name}`);

    return reply.code(201).send({
      party_id: room.party_id,
      short_id: room.short_id,
      deep_link: `${request.protocol}://${request.hostname}/${room.short_id}`,
      user: {
        id: user_id,
        display_name,
        is_owner: true,
      },
      ...roomSnapshot(room),
    });
  });


  // ── POST /api/join/:id  (Join Room) ─────────────────────────────────────
  fastify.post('/api/join/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          user_id: { type: 'string' },
          display_name: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const room = getRoom(id);

    if (!room) {
      return reply.code(404).send({ error: 'Room not found', code: 'ROOM_NOT_FOUND' });
    }

    const display_name = request.body?.display_name || 'Guest';
    const user_id = request.body?.user_id || `u_${nanoid(8)}`;

    console.log(`[REST] Room join: ${room.short_id} (party_id=${room.party_id})`);

    return reply.code(200).send({
      party_id: room.party_id,
      short_id: room.short_id,
      deep_link: `${request.protocol}://${request.hostname}/${room.short_id}`,
      user: {
        id: user_id,
        display_name,
        is_owner: room.creator_id === user_id,
      },
      ...roomSnapshot(room),
    });
  });


  // ── POST /api/party/:id  (Update Room State via REST) ────────────────────
  fastify.post('/api/party/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const room = getRoom(id);

    if (!room) {
      return reply.code(404).send({ error: 'Room not found', code: 'ROOM_NOT_FOUND' });
    }

    const { sync, video, settings } = request.body ?? {};

    if (sync) updateSync(room.party_id, sync);
    if (video) updateVideo(room.party_id, video);
    if (settings?.shared_controls !== undefined) {
      room.shared_controls = !!settings.shared_controls;
    }

    return reply.code(200).send(roomSnapshot(room));
  });


  // ── GET /api/party/:id  (Get Room Snapshot) ──────────────────────────────
  fastify.get('/api/party/:id', async (request, reply) => {
    const { id } = request.params;
    const room = getRoom(id);
    if (!room) return reply.code(404).send({ error: 'Room not found' });
    return reply.send(roomSnapshot(room));
  });


  // ── GET /api/health ───────────────────────────────────────────────────────
  fastify.get('/api/health', async () => ({
    status: 'ok',
    server_time: Date.now(),
    uptime: process.uptime(),
  }));

  // ── GET /api/version ──────────────────────────────────────────────────────
  fastify.get('/api/version', async () => ({
    version: '1.4.0',
  }));

  // ── GET /api/time ─────────────────────────────────────────────────────────
  fastify.get('/api/time', async () => ({
    server_time: Date.now(),
    epoch: Date.now(),
  }));
}

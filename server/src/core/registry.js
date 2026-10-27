/**
 * StreamSync - Room Registry
 * Manages active party rooms, peer connections, and broadcast logic.
 * Pure in-memory for MVP. No database dependency required.
 */

import { nanoid } from 'nanoid';

/** @type {Map<string, Room>} Keyed by party_id (UUID-style) */
const rooms = new Map();

/** @type {Map<string, string>} short_id -> party_id reverse lookup */
const codeIndex = new Map();

/**
 * @typedef {Object} VideoState
 * @property {string} url
 * @property {'mp4'|'hls'|'youtube'|'dash'} provider
 * @property {string} title
 * @property {string} thumbnail
 */

/**
 * @typedef {Object} SyncState
 * @property {number|null} started  - NTP epoch ms when play began: NTP_now - position_ms
 * @property {number|null} paused   - position ms when paused, null if playing
 */

/**
 * @typedef {Object} Room
 * @property {string} party_id
 * @property {string} short_id
 * @property {string} creator_id
 * @property {boolean} shared_controls
 * @property {VideoState} video
 * @property {SyncState} sync
 * @property {Map<string, { ws: import('ws').WebSocket, user: PeerInfo }>} peers
 * @property {number} created_at
 */

/**
 * @typedef {Object} PeerInfo
 * @property {string} id
 * @property {string} display_name
 * @property {boolean} is_owner
 */

/**
 * Creates a new party room.
 * @param {{ creator_id: string, display_name: string, shared_controls: boolean, video?: VideoState }} opts
 * @returns {Room}
 */
export function createRoom({ creator_id, display_name, shared_controls = true, video = null }) {
  const party_id = `p_${nanoid(16)}`;
  const short_id = nanoid(6).toUpperCase();

  const room = {
    party_id,
    short_id,
    creator_id,
    shared_controls,
    video: video ?? {
      url: '',
      provider: 'mp4',
      title: '',
      thumbnail: '',
    },
    sync: {
      started: null,
      paused: 0,
    },
    browsing: false,
    peers: new Map(),
    created_at: Date.now(),
  };

  rooms.set(party_id, room);
  codeIndex.set(short_id, party_id);
  return room;
}

/**
 * Look up a room by short_id or party_id.
 * @param {string} id - Either the 6-char short code or the full party_id.
 * @returns {Room|undefined}
 */
export function getRoom(id) {
  // Try direct party_id first
  if (rooms.has(id)) return rooms.get(id);
  // Try short_id lookup
  const party_id = codeIndex.get(id.toUpperCase());
  if (party_id) return rooms.get(party_id);
  return undefined;
}

/**
 * Attach a WebSocket peer to a room.
 * @param {string} party_id
 * @param {string} conn_id - Unique connection ID assigned on upgrade
 * @param {import('ws').WebSocket} ws
 * @param {PeerInfo} user
 */
export function addPeer(party_id, conn_id, ws, user) {
  const room = rooms.get(party_id);
  if (!room) throw new Error(`Room ${party_id} not found`);
  room.peers.set(conn_id, { ws, user });
}

/**
 * Remove a peer from a room by connection ID. Cleans up empty rooms.
 * @param {string} party_id
 * @param {string} conn_id
 */
export function removePeer(party_id, conn_id) {
  const room = rooms.get(party_id);
  if (!room) return;
  room.peers.delete(conn_id);
  // Auto-cleanup rooms with no peers after 60 seconds
  if (room.peers.size === 0) {
    setTimeout(() => {
      const r = rooms.get(party_id);
      if (r && r.peers.size === 0) {
        rooms.delete(party_id);
        codeIndex.delete(r.short_id);
      }
    }, 60_000);
  }
}

/**
 * Update the sync state in a room.
 * @param {string} party_id
 * @param {Partial<SyncState>} sync
 */
export function updateSync(party_id, sync) {
  const room = rooms.get(party_id);
  if (!room) return;
  Object.assign(room.sync, sync);
}

/**
 * Update the video in a room.
 * @param {string} party_id
 * @param {Partial<VideoState>} video
 */
export function updateVideo(party_id, video) {
  const room = rooms.get(party_id);
  if (!room) return;
  Object.assign(room.video, video);
}

/**
 * Broadcast a JSON message to all peers in a room, optionally excluding one.
 * @param {string} party_id
 * @param {object} payload
 * @param {string|null} exclude_conn_id - Connection to skip (e.g. the sender)
 */
export function broadcast(party_id, payload, exclude_conn_id = null) {
  const room = rooms.get(party_id);
  if (!room) return;
  const msg = JSON.stringify(payload);
  for (const [conn_id, { ws }] of room.peers) {
    if (conn_id === exclude_conn_id) continue;
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(msg);
    }
  }
}

/**
 * Get a serializable snapshot of the current room (without raw WS objects).
 * @param {Room} room
 * @returns {object}
 */
export function roomSnapshot(room) {
  return {
    party_id: room.party_id,
    short_id: room.short_id,
    creator_id: room.creator_id,
    shared_controls: room.shared_controls,
    browsing: room.browsing ?? false,
    video: room.video,
    sync: room.sync,
    users: [...room.peers.values()].map(({ user }) => user),
  };
}

/**
 * StreamSync - High-Level Sync Client
 * 
 * Orchestrates WebSocket transport, ClockSynchronizer, VirtualTimeline,
 * and DriftEngine to provide a turnkey synchronization runtime.
 * Compatible with browsers, WebExtensions, and Node.js environments.
 */

import { ClockSynchronizer } from './clock.js';
import { VirtualTimeline } from './timeline.js';
import { DriftEngine } from './drift.js';

export class SyncClient {
  /**
   * @param {Object} [options]
   * @param {import('./adapter/base.js').BasePlayerAdapter} [options.player] Player adapter instance
   * @param {typeof WebSocket} [options.WebSocketImpl] Custom WebSocket constructor (defaults to globalThis.WebSocket)
   * @param {number} [options.pingIntervalMs=4000] Clock sync ping interval
   * @param {number} [options.driftCheckIntervalMs=250] Drift engine check interval
   */
  constructor(options = {}) {
    this.options = options;
    this.player = options.player ?? null;
    this.WebSocketClass = options.WebSocketImpl || globalThis.WebSocket;
    this.pingIntervalMs = options.pingIntervalMs ?? 4000;
    this.driftCheckIntervalMs = options.driftCheckIntervalMs ?? 250;

    this.clock = options.clock || new ClockSynchronizer({
      pingIntervalMs: this.pingIntervalMs,
      ...(options.clockOptions || {}),
    });

    this.timeline = new VirtualTimeline();

    /** @type {DriftEngine|null} */
    this.driftEngine = null;

    /** @type {WebSocket|null} */
    this.ws = null;

    /** Current room info */
    this.room = {
      partyId: null,
      shortId: null,
      sharedControls: true,
      creatorId: null,
      video: null,
      peers: new Map(),
    };

    /** Local user profile */
    this.user = {
      id: null,
      displayName: 'Guest',
      isOwner: false,
    };

    /** @type {Map<string, Set<Function>>} */
    this.events = new Map();

    /** @type {NodeJS.Timeout|number|null} */
    this.reconnectTimer = null;
    this.shouldReconnect = false;

    // Attach clock transport sender
    this.clock.setTransport((msg) => this.send(msg));

    if (this.player) {
      this.attachPlayer(this.player);
    }
  }

  /**
   * Bind or rebind a player adapter.
   * @param {import('./adapter/base.js').BasePlayerAdapter} player
   */
  attachPlayer(player) {
    if (this.driftEngine) {
      this.driftEngine.stop();
    }

    this.player = player;
    this.driftEngine = new DriftEngine({
      timeline: this.timeline,
      clock: this.clock,
      player: this.player,
      checkIntervalMs: this.driftCheckIntervalMs,
      ...(this.options.driftOptions || {}),
    });

    // Bubble drift reports
    this.driftEngine.subscribe((report) => {
      this.emit('drift', report);
    });

    // Bind player user interactions to transmit over room if permitted
    this._bindPlayerActions();

    if (this.isConnected()) {
      this.driftEngine.start();
    }
  }

  /**
   * Connect to StreamSync relay server WebSocket.
   * @param {Object} params
   * @param {string} params.url Relay server base URL (e.g. 'ws://localhost:3001/ws' or 'http://localhost:3001')
   * @param {string} params.partyId Party room ID or short code
   * @param {string} [params.userId] User UUID
   * @param {string} [params.displayName] Display name
   * @returns {Promise<void>}
   */
  async connect({ url, partyId, userId, displayName }) {
    this.shouldReconnect = true;
    this.user.id = userId || `u_${Math.random().toString(36).slice(2, 10)}`;
    this.user.displayName = displayName || 'Peer';

    // Normalize WS endpoint URL
    let wsUrl = url.replace(/^http/, 'ws');
    if (!wsUrl.includes('/ws')) {
      wsUrl = wsUrl.replace(/\/+$/, '') + '/ws';
    }

    const query = new URLSearchParams({
      party_id: partyId,
      user_id: this.user.id,
      display_name: this.user.displayName,
    });

    const fullUrl = `${wsUrl}?${query.toString()}`;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new this.WebSocketClass(fullUrl);
      } catch (err) {
        return reject(err);
      }

      this.ws.onopen = () => {
        this.emit('connected');
        // Start continuous clock calibration immediately
        this.clock.start();

        if (this.driftEngine) {
          this.driftEngine.start();
        }
        resolve();
      };

      this.ws.onmessage = (event) => {
        this._handleMessage(typeof event.data === 'string' ? event.data : event.data.toString());
      };

      this.ws.onerror = (err) => {
        this.emit('error', err);
      };

      this.ws.onclose = () => {
        this.clock.stop();
        if (this.driftEngine) {
          this.driftEngine.stop();
        }
        this.emit('disconnected');

        if (this.shouldReconnect) {
          this.reconnectTimer = setTimeout(() => {
            this.connect({ url, partyId, userId, displayName }).catch(() => {});
          }, 3000);
        }
      };
    });
  }

  /**
   * Route inbound messages from relay server.
   * @param {string} raw
   * @private
   */
  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'pong':
        this.clock.handlePong(msg);
        break;

      case 'joined':
        this.room.partyId = msg.party_id;
        this.room.shortId = msg.short_id;
        this.room.creatorId = msg.creator_id;
        this.room.sharedControls = !!msg.shared_controls;
        this.user.isOwner = (this.user.id === msg.creator_id);

        if (msg.sync) {
          this.timeline.applySync(msg.sync);
        }
        if (msg.video) {
          this.room.video = msg.video;
        }
        if (Array.isArray(msg.peers)) {
          this.room.peers = new Map(msg.peers.map(p => [p.id, p]));
          this.emit('peers', this.room.peers);
        } else if (Array.isArray(msg.users)) {
          this.room.peers = new Map(msg.users.map(u => [u.id, u]));
          this.emit('peers', this.room.peers);
        }

        this.emit('joined', {
          room: this.room,
          user: this.user,
        });
        break;

      case 'party':
        if (msg.sync) {
          this.timeline.applySync(msg.sync);
        }
        if (msg.video) {
          this.room.video = msg.video;
        }
        if (msg.shared_controls !== undefined) {
          this.room.sharedControls = msg.shared_controls;
        }
        if (Array.isArray(msg.users)) {
          this.room.peers = new Map(msg.users.map(u => [u.id, u]));
          this.emit('peers', this.room.peers);
        }

        this.emit('party_update', {
          sync: this.timeline.getState(),
          video: this.room.video,
          senderId: msg.sender_id,
        });
        break;

      case 'users':
        if (Array.isArray(msg.users)) {
          this.room.peers = new Map(msg.users.map(u => [u.id, u]));
          this.emit('peers', this.room.peers);
        }
        break;

      case 'peer_join':
        this.room.peers.set(msg.peer.id, msg.peer);
        this.emit('peer_join', msg.peer);
        this.emit('peers', this.room.peers);
        break;

      case 'peer_leave':
        this.room.peers.delete(msg.peer_id);
        this.emit('peer_leave', msg.peer_id);
        this.emit('peers', this.room.peers);
        break;

      case 'chat':
        this.emit('chat', msg);
        break;

      case 'typing':
        this.emit('typing', msg);
        break;

      default:
        this.emit('message', msg);
    }
  }

  /**
   * Send JSON message over WebSocket transport.
   * @param {Object} payload
   */
  send(payload) {
    if (this.ws && this.ws.readyState === (this.WebSocketClass.OPEN ?? 1)) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  /**
   * Whether the client can control playback in the room.
   * @returns {boolean}
   */
  canControl() {
    return this.room.sharedControls || this.user.isOwner;
  }

  /**
   * Broadcast play action to room.
   */
  play() {
    if (!this.canControl()) return;
    const ntpNow = this.clock.now();
    const currentMs = this.player ? Math.round(this.player.getCurrentTime() * 1000) : 0;
    const sync = this.timeline.play(ntpNow, currentMs);

    this.send({
      type: 'party',
      sync,
    });
  }

  /**
   * Broadcast pause action to room.
   */
  pause() {
    if (!this.canControl()) return;
    const ntpNow = this.clock.now();
    const currentMs = this.player ? Math.round(this.player.getCurrentTime() * 1000) : 0;
    const sync = this.timeline.pause(ntpNow, currentMs);

    this.send({
      type: 'party',
      sync,
    });
  }

  /**
   * Broadcast seek action to room.
   * @param {number} positionSeconds
   */
  seek(positionSeconds) {
    if (!this.canControl()) return;
    const ntpNow = this.clock.now();
    const positionMs = Math.round(positionSeconds * 1000);
    const sync = this.timeline.seek(ntpNow, positionMs);

    this.send({
      type: 'party',
      sync,
    });
  }

  /**
   * Broadcast video change (switch show/movie).
   * @param {{ url: string, provider: 'mp4'|'hls'|'youtube'|'dash', title: string, thumbnail?: string }} video
   */
  changeVideo(video) {
    if (!this.user.isOwner) return;
    this.send({
      type: 'party',
      video,
    });
  }

  /**
   * Send text chat message.
   * @param {string} content
   */
  sendChat(content) {
    this.send({
      type: 'chat',
      content,
    });
  }

  /**
   * Send typing indicator.
   * @param {boolean} isTyping
   */
  setTyping(isTyping) {
    this.send({
      type: 'typing',
      is_typing: !!isTyping,
    });
  }

  /**
   * Listen for user interactions on the player adapter.
   * @private
   */
  _bindPlayerActions() {
    if (!this.player) return;

    this.player.on('play', () => {
      if (this.canControl()) {
        this.play();
      }
    });

    this.player.on('pause', () => {
      if (this.canControl()) {
        this.pause();
      }
    });

    this.player.on('seek', (currentTimeSec) => {
      if (this.canControl()) {
        this.seek(currentTimeSec);
      }
    });
  }

  isConnected() {
    return this.ws && this.ws.readyState === (this.WebSocketClass.OPEN ?? 1);
  }

  on(event, handler) {
    if (!this.events.has(event)) {
      this.events.set(event, new Set());
    }
    this.events.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const handlers = this.events.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  emit(event, ...args) {
    const handlers = this.events.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(...args);
      } catch (err) {
        console.error(`[SyncClient] Event handler error (${event}):`, err);
      }
    }
  }

  /**
   * Disconnect and release all resources.
   */
  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clock.stop();
    if (this.driftEngine) {
      this.driftEngine.stop();
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

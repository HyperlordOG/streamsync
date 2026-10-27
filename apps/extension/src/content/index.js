/**
 * StreamSync - Extension Content Script Entrypoint
 * Injected into Netflix, Prime Video, YouTube, and Web Stream tabs.
 */

import { SyncClient } from '@streamsync/sync-engine';
import { createPlayerAdapter } from '@streamsync/injectors';
import { StreamSyncOverlay } from './overlay.js';

// Embedded CSS stylesheet for the floating widget
const OVERLAY_CSS = `
:host {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #f1f5f9;
  z-index: 2147483647;
  position: fixed;
  top: 24px;
  right: 24px;
}
* { box-sizing: border-box; }
.streamsync-widget {
  width: 320px;
  background: rgba(15, 23, 42, 0.88);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 16px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6), 0 0 1px 1px rgba(255, 255, 255, 0.1);
  overflow: hidden;
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), width 0.3s ease;
  user-select: none;
}
.streamsync-widget.collapsed {
  width: auto;
  border-radius: 9999px;
  background: rgba(15, 23, 42, 0.95);
}
.streamsync-widget.collapsed .streamsync-body { display: none; }
.streamsync-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.04);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  cursor: grab;
}
.streamsync-widget.collapsed .streamsync-header {
  border-bottom: none;
  padding: 8px 12px;
}
.streamsync-brand { display: flex; align-items: center; gap: 8px; }
.streamsync-logo {
  width: 22px; height: 22px;
  background: linear-gradient(135deg, #6366f1, #a855f7);
  border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-weight: 800; font-size: 11px; color: #fff;
  box-shadow: 0 0 10px rgba(168, 85, 247, 0.4);
}
.streamsync-title { font-size: 13px; font-weight: 700; color: #fff; }
.streamsync-header-actions { display: flex; align-items: center; gap: 6px; }
.streamsync-btn-icon {
  background: transparent; border: none; color: #94a3b8;
  cursor: pointer; padding: 4px; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s ease;
}
.streamsync-btn-icon:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
.streamsync-status-bar {
  padding: 10px 14px;
  display: flex; align-items: center; justify-content: space-between;
  background: rgba(0, 0, 0, 0.25);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.streamsync-pill {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; font-weight: 600; padding: 3px 8px;
  border-radius: 9999px; text-transform: uppercase; letter-spacing: 0.04em;
}
.streamsync-pill.in_sync {
  background: rgba(34, 197, 94, 0.15); color: #4ade80;
  border: 1px solid rgba(34, 197, 94, 0.3);
}
.streamsync-pill.slewing {
  background: rgba(234, 179, 8, 0.15); color: #facc15;
  border: 1px solid rgba(234, 179, 8, 0.3);
}
.streamsync-pill.seeking, .streamsync-pill.buffering {
  background: rgba(239, 68, 68, 0.15); color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.3);
}
.streamsync-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.streamsync-pill.slewing .streamsync-dot,
.streamsync-pill.seeking .streamsync-dot {
  animation: streamsync-pulse 1.2s infinite ease-in-out;
}
@keyframes streamsync-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}
.streamsync-room-chip {
  display: flex; align-items: center; gap: 6px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.1);
  padding: 3px 8px; border-radius: 8px; cursor: pointer;
  transition: all 0.15s ease;
}
.streamsync-room-chip:hover { background: rgba(255, 255, 255, 0.15); }
.streamsync-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 700; font-size: 12px; letter-spacing: 0.06em; color: #e2e8f0;
}
.streamsync-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
.streamsync-peers-wrap { display: flex; flex-direction: column; gap: 6px; }
.streamsync-section-label { font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; }
.streamsync-peers-list { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.streamsync-peer-avatar {
  width: 28px; height: 28px; border-radius: 50%;
  background: linear-gradient(135deg, #3b82f6, #06b6d4);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 12px; color: #fff;
  border: 1.5px solid rgba(255, 255, 255, 0.2); position: relative;
}
.streamsync-peer-avatar.is-owner::after {
  content: '👑'; position: absolute; top: -6px; right: -4px; font-size: 10px;
}
.streamsync-chat-box {
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px; display: flex; flex-direction: column;
  height: 140px; overflow: hidden;
}
.streamsync-messages {
  flex: 1; padding: 8px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; font-size: 11px;
}
.streamsync-msg { display: flex; flex-direction: column; gap: 2px; line-height: 1.35; }
.streamsync-msg-sender { font-weight: 700; font-size: 10px; color: #94a3b8; }
.streamsync-msg-text { color: #f1f5f9; word-break: break-word; }
.streamsync-typing { font-size: 10px; color: #64748b; font-style: italic; padding: 2px 8px; min-height: 16px; }
.streamsync-chat-input-row {
  display: flex; align-items: center; border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.02);
}
.streamsync-chat-input {
  flex: 1; background: transparent; border: none; padding: 8px 10px; color: #fff; font-size: 11px; outline: none;
}
.streamsync-chat-input::placeholder { color: #64748b; }
.streamsync-send-btn {
  background: transparent; border: none; color: #818cf8; padding: 6px 10px; cursor: pointer; font-size: 12px; display: flex; align-items: center;
}
.streamsync-send-btn:hover { color: #a5b4fc; }
.streamsync-toast {
  position: absolute; bottom: 8px; left: 50%;
  transform: translateX(-50%) translateY(20px);
  background: rgba(16, 185, 129, 0.95); color: #fff;
  padding: 4px 10px; border-radius: 9999px; font-size: 10px; font-weight: 700;
  opacity: 0; pointer-events: none; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.streamsync-toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }
`;

class StreamSyncRuntime {
  constructor() {
    this.client = null;
    this.adapter = null;
    this.overlay = null;
    this.serverUrl = 'http://localhost:3001';
    this.userId = 'u_' + Math.random().toString(36).slice(2, 10);

    this.init();
  }

  async init() {
    // 1. Immediately bind extension popup message listener (zero delay)
    this._bindExtensionMessages();

    // 2. Discover active video stream adapter
    this.adapter = createPlayerAdapter({ targetWindow: window });

    // 3. Initialize Turnkey SyncClient
    this.client = new SyncClient({
      player: this.adapter,
    });

    // 4. Asynchronously wait for player to mount without blocking popup messages
    if (typeof this.adapter.waitForPlayer === 'function') {
      this.adapter.waitForPlayer(10000).catch(() => {});
    }

    // 5. Check URL params or local storage for auto-join party
    const params = new URLSearchParams(window.location.search);
    const autoParty = params.get('streamsync_party');
    if (autoParty) {
      await this.joinParty(autoParty);
    }

    console.log('[StreamSync] Content script active on:', window.location.hostname);
  }

  async createParty(displayName = 'Host') {
    try {
      // Call REST relay server
      const res = await fetch(`${this.serverUrl}/api/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: this.userId,
          display_name: displayName,
          shared_controls: true,
          video: {
            url: window.location.href,
            provider: this._detectProvider(),
            title: document.title,
          },
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.party_id) {
        throw new Error(data.message || data.error || 'Failed to create party');
      }

      // Connect WebSocket client
      await this.client.connect({
        url: this.serverUrl,
        partyId: data.party_id,
        userId: data.user?.id || this.userId,
        displayName: data.user?.display_name || displayName,
      });

      // Mount floating overlay with resolved shortId
      this._mountOverlay(data.short_id);

      return data;
    } catch (err) {
      console.error('[StreamSync] Create party error:', err);
      throw err;
    }
  }

  async joinParty(shortCodeOrId, displayName = 'Guest') {
    try {
      const res = await fetch(`${this.serverUrl}/api/join/${shortCodeOrId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: this.userId,
          display_name: displayName,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.party_id) {
        throw new Error(data.message || data.error || 'Party not found');
      }

      await this.client.connect({
        url: this.serverUrl,
        partyId: data.party_id,
        userId: data.user?.id || this.userId,
        displayName: data.user?.display_name || displayName,
      });

      this._mountOverlay(data.short_id || shortCodeOrId);

      return data;
    } catch (err) {
      console.error('[StreamSync] Join party error:', err);
      throw err;
    }
  }

  _mountOverlay(shortId = null) {
    if (this.overlay) {
      this.overlay.destroy();
    }
    this.overlay = new StreamSyncOverlay({
      client: this.client,
      cssText: OVERLAY_CSS,
      serverUrl: this.serverUrl,
      shortId: shortId || this.client?.room?.shortId,
    });
  }

  _detectProvider() {
    const host = window.location.hostname;
    if (host.includes('netflix')) return 'netflix';
    if (host.includes('primevideo') || host.includes('amazon')) return 'prime';
    if (host.includes('youtube')) return 'youtube';
    return 'mp4';
  }

  _bindExtensionMessages() {
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'CREATE_PARTY') {
          this.createParty(request.displayName)
            .then(sendResponse)
            .catch((err) => sendResponse({ error: err.message }));
          return true;
        }

        if (request.action === 'JOIN_PARTY') {
          this.joinParty(request.code, request.displayName)
            .then(sendResponse)
            .catch((err) => sendResponse({ error: err.message }));
          return true;
        }

        if (request.action === 'GET_STATUS') {
          sendResponse({
            connected: this.client?.isConnected() || false,
            room: this.client?.room || null,
            provider: this._detectProvider(),
          });
        }
      });
    }
  }
}

// Instantiate runtime
if (typeof window !== 'undefined') {
  window.__STREAMSYNC_RUNTIME__ = new StreamSyncRuntime();
}

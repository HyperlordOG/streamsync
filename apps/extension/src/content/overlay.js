/**
 * StreamSync - Floating Watch Party Overlay Controller
 * Mounts draggable, collapsible UI into Shadow DOM on streaming web pages.
 */

export class StreamSyncOverlay {
  /**
   * @param {Object} options
   * @param {import('@streamsync/sync-engine').SyncClient} options.client
   * @param {string} options.cssText Raw CSS stylesheet text
   * @param {string} [options.serverUrl='http://localhost:3001']
   */
  constructor(options) {
    this.client = options.client;
    this.cssText = options.cssText;
    this.serverUrl = (options.serverUrl || 'http://localhost:3001').replace(/\/+$/, '');
    this.shortId = options.shortId || this.client?.room?.shortId || null;

    this.container = null;
    this.shadowRoot = null;
    this.isCollapsed = false;
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };
    this.typingTimer = null;

    this.mount();
  }

  mount() {
    if (document.getElementById('streamsync-overlay-host')) {
      return;
    }

    this.container = document.createElement('div');
    this.container.id = 'streamsync-overlay-host';
    this.shadowRoot = this.container.attachShadow({ mode: 'open' });

    // Inject stylesheet
    const style = document.createElement('style');
    style.textContent = this.cssText;
    this.shadowRoot.appendChild(style);

    const activeCode = this.shortId || this.client?.room?.shortId || '------';

    // Build DOM structure
    const widget = document.createElement('div');
    widget.className = 'streamsync-widget';
    widget.innerHTML = `
      <!-- Header / Drag Bar -->
      <div class="streamsync-header" id="drag-handle">
        <div class="streamsync-brand">
          <div class="streamsync-logo">S</div>
          <span class="streamsync-title">StreamSync</span>
        </div>
        <div class="streamsync-header-actions">
          <button class="streamsync-btn-icon" id="btn-collapse" title="Collapse / Expand">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 15l-6-6-6 6"/></svg>
          </button>
          <button class="streamsync-btn-icon" id="btn-close" title="Leave Party">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>

      <!-- Status Bar -->
      <div class="streamsync-status-bar">
        <div class="streamsync-pill in_sync" id="status-pill">
          <span class="streamsync-dot"></span>
          <span id="status-text">PAUSED (IN SYNC)</span>
        </div>

        <div class="streamsync-room-chip" id="btn-copy-code" title="Click to copy invite link">
          <span class="streamsync-code" id="room-code-display">${activeCode}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </div>
      </div>

      <!-- Main Body -->
      <div class="streamsync-body">
        <!-- Peers -->
        <div class="streamsync-peers-wrap">
          <div class="streamsync-section-label">Watching Now (<span id="peers-count">1</span>)</div>
          <div class="streamsync-peers-list" id="peers-list"></div>
        </div>

        <!-- Chat -->
        <div class="streamsync-chat-box">
          <div class="streamsync-messages" id="chat-messages">
            <div class="streamsync-msg">
              <span class="streamsync-msg-sender">System</span>
              <span class="streamsync-msg-text">Watch Party ready! Room Code: <b>${activeCode}</b>. Click the code pill above to copy your invite link.</span>
            </div>
          </div>
          <div class="streamsync-typing" id="typing-indicator"></div>
          <div class="streamsync-chat-input-row">
            <input type="text" class="streamsync-chat-input" id="chat-input" placeholder="Say something..." maxlength="500" />
            <button class="streamsync-send-btn" id="btn-send-chat" title="Send">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
        </div>
      </div>

      <!-- Toast Feedback -->
      <div class="streamsync-toast" id="toast">Link Copied!</div>
    `;

    this.shadowRoot.appendChild(widget);
    document.body.appendChild(this.container);

    this._bindInteractions();
    this._bindClientEvents();
  }

  _bindInteractions() {
    const root = this.shadowRoot;
    const widget = root.querySelector('.streamsync-widget');
    const dragHandle = root.querySelector('#drag-handle');
    const btnCollapse = root.querySelector('#btn-collapse');
    const btnClose = root.querySelector('#btn-close');
    const btnCopy = root.querySelector('#btn-copy-code');
    const chatInput = root.querySelector('#chat-input');
    const btnSendChat = root.querySelector('#btn-send-chat');

    // Dragging
    dragHandle.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      const rect = this.container.getBoundingClientRect();
      this.dragOffset.x = e.clientX - rect.left;
      this.dragOffset.y = e.clientY - rect.top;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      const x = Math.max(10, Math.min(window.innerWidth - 330, e.clientX - this.dragOffset.x));
      const y = Math.max(10, Math.min(window.innerHeight - 200, e.clientY - this.dragOffset.y));
      this.container.style.left = `${x}px`;
      this.container.style.top = `${y}px`;
      this.container.style.right = 'auto';
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    // Collapse toggle
    btnCollapse.addEventListener('click', () => {
      this.isCollapsed = !this.isCollapsed;
      widget.classList.toggle('collapsed', this.isCollapsed);
    });

    // Close / Disconnect
    btnClose.addEventListener('click', () => {
      if (confirm('Leave StreamSync Watch Party?')) {
        this.client.disconnect();
        this.destroy();
      }
    });

    // Copy Invite Link
    btnCopy.addEventListener('click', () => {
      const shortId = this.client?.room?.shortId || this.shortId || '676767';
      const link = `${this.serverUrl}/party/${shortId}`;
      navigator.clipboard.writeText(link).then(() => {
        this.showToast('Invite Link Copied!');
      }).catch(() => {
        this.showToast(`Code: ${shortId}`);
      });
    });

    // Chat Send
    const sendCurrentMessage = () => {
      const text = chatInput.value.trim();
      if (!text) return;
      this.client.sendChat(text);
      chatInput.value = '';
      this.client.setTyping(false);
    };

    btnSendChat.addEventListener('click', sendCurrentMessage);
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        sendCurrentMessage();
      } else {
        this._notifyTyping();
      }
    });
  }

  _notifyTyping() {
    this.client.setTyping(true);
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => {
      this.client.setTyping(false);
    }, 2000);
  }

  _bindClientEvents() {
    const root = this.shadowRoot;
    const roomCodeDisplay = root.querySelector('#room-code-display');
    const statusPill = root.querySelector('#status-pill');
    const statusText = root.querySelector('#status-text');
    const peersCount = root.querySelector('#peers-count');
    const peersList = root.querySelector('#peers-list');
    const chatMessages = root.querySelector('#chat-messages');
    const typingIndicator = root.querySelector('#typing-indicator');

    // Immediately reflect active room code & peers if already loaded
    const initialCode = this.client?.room?.shortId || this.shortId;
    if (initialCode) {
      roomCodeDisplay.textContent = initialCode;
    }
    if (this.client?.room?.peers?.size) {
      this._updatePeers(this.client.room.peers, this.client.user?.id);
    }

    // On Room Joined
    this.client.on('joined', ({ room, user }) => {
      if (room.shortId) {
        this.shortId = room.shortId;
        roomCodeDisplay.textContent = room.shortId;
      }
      this._updatePeers(room.peers, user.id);
    });

    // Drift Engine updates status pill
    this.client.on('drift', (report) => {
      statusPill.className = `streamsync-pill ${report.state}`;

      switch (report.state) {
        case 'in_sync':
          const isPaused = this.client?.timeline?.isPaused();
          statusText.textContent = isPaused ? 'PAUSED (IN SYNC)' : `IN SYNC (${report.absDeltaMs}ms)`;
          break;
        case 'slewing':
          statusText.textContent = `SLEWING ${report.playbackRate}x`;
          break;
        case 'seeking':
          statusText.textContent = 'SEEKING...';
          break;
        case 'buffering':
          statusText.textContent = 'BUFFERING...';
          break;
      }
    });

    // Peer updates
    this.client.on('peers', (peersMap) => {
      this._updatePeers(peersMap, this.client.user?.id);
    });

    this.client.on('peer_join', () => {
      this._updatePeers(this.client.room?.peers, this.client.user?.id);
    });

    this.client.on('peer_leave', () => {
      this._updatePeers(this.client.room?.peers, this.client.user?.id);
    });

    // Inbound Chat
    this.client.on('chat', (msg) => {
      const item = document.createElement('div');
      item.className = 'streamsync-msg';
      item.innerHTML = `
        <span class="streamsync-msg-sender">${escapeHtml(msg.display_name || 'Guest')}</span>
        <span class="streamsync-msg-text">${escapeHtml(msg.content)}</span>
      `;
      chatMessages.appendChild(item);
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });

    // Inbound Typing
    this.client.on('typing', (msg) => {
      if (msg.is_typing) {
        typingIndicator.textContent = `${msg.display_name} is typing...`;
      } else {
        typingIndicator.textContent = '';
      }
    });
  }

  _updatePeers(peersMap, localUserId) {
    const root = this.shadowRoot;
    if (!root) return;
    const peersCount = root.querySelector('#peers-count');
    const peersList = root.querySelector('#peers-list');

    let peers = [];
    if (peersMap instanceof Map) {
      peers = Array.from(peersMap.values());
    } else if (Array.isArray(peersMap)) {
      peers = peersMap;
    }

    if (peersCount) {
      peersCount.textContent = peers.length;
    }

    if (peersList) {
      peersList.innerHTML = '';
      peers.forEach((peer) => {
        const avatar = document.createElement('div');
        avatar.className = `streamsync-peer-avatar ${peer.is_owner ? 'is-owner' : ''}`;
        avatar.title = `${peer.display_name}${peer.is_owner ? ' (Host)' : ''}${peer.id === localUserId ? ' (You)' : ''}`;
        avatar.textContent = (peer.display_name || 'U').slice(0, 1).toUpperCase();
        peersList.appendChild(avatar);
      });
    }
  }

  showToast(text) {
    const toast = this.shadowRoot.querySelector('#toast');
    toast.textContent = text;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 2000);
  }

  destroy() {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

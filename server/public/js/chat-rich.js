/**
 * StreamSync - Rich Chat System (Phase 2)
 * WhatsApp-style in-party messaging with Emoji Picker, Sticker Packs,
 * Tenor GIF Search, File/Image Attachments, Quoted Replies, and Live Reactions.
 */

// Helper to escape HTML safely
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Format bytes into readable string
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * EmojiPicker Class
 * Loads emoji-mart from CDN dynamically and mounts it into a floating popover.
 */
function positionPicker(el, anchorEl) {
  if (!el) return;
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 680;
  if (!anchorEl || !anchorEl.getBoundingClientRect) {
    el.style.position = 'fixed';
    el.style.bottom = isMobile ? '70px' : '80px';
    el.style.left = isMobile ? '10px' : 'auto';
    el.style.right = isMobile ? '10px' : '20px';
    return;
  }
  const rect = anchorEl.getBoundingClientRect();
  if (isMobile) {
    el.style.position = 'fixed';
    el.style.bottom = `${Math.max(10, window.innerHeight - rect.top + 8)}px`;
    el.style.left = '8px';
    el.style.right = '8px';
    el.style.width = 'auto';
    el.style.maxWidth = 'calc(100vw - 16px)';
  } else {
    el.style.position = 'fixed';
    el.style.bottom = `${Math.max(10, window.innerHeight - rect.top + 8)}px`;
    const leftPos = Math.max(10, Math.min(rect.left - 100, window.innerWidth - 350));
    el.style.left = `${leftPos}px`;
    el.style.width = '340px';
    el.style.right = 'auto';
  }
}

export class EmojiPicker {
  constructor(onSelect) {
    this.onSelect = onSelect;
    this.pickerElement = null;
    this.isOpen = false;
    this.initialized = false;
    this.container = null;
  }

  async init(container) {
    this.container = container;
    // Load emoji-mart CDN if not already loaded
    if (!window.EmojiMart) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/emoji-mart@5.6.0/dist/browser.js';
        script.async = true;
        script.onload = resolve;
        script.onerror = () => {
          console.warn('[EmojiPicker] CDN load failed, using native emoji fallback');
          resolve();
        };
        document.head.appendChild(script);
      });
    }
    this.initialized = true;
  }

  open(anchorElement) {
    if (this.isOpen) {
      this.close();
      return;
    }

    if (!this.pickerElement) {
      this.pickerElement = document.createElement('div');
      this.pickerElement.className = 'ss-picker-popover ss-emoji-popover';
      document.body.appendChild(this.pickerElement);

      if (window.EmojiMart && window.EmojiMart.Picker) {
        const picker = new window.EmojiMart.Picker({
          theme: 'dark',
          previewPosition: 'none',
          skinTonePosition: 'none',
          navPosition: 'bottom',
          onEmojiSelect: (emoji) => {
            if (this.onSelect && emoji?.native) {
              this.onSelect(emoji.native);
            }
          },
        });
        this.pickerElement.appendChild(picker);
      } else {
        // Fallback quick emoji grid
        const fallbackEmojis = ['😀', '😂', '😍', '🔥', '👏', '🍿', '🎬', '😱', '💀', '🎉', '👍', '❤️', '🤯', '😴', '🤌', '👀'];
        this.pickerElement.innerHTML = `
          <div class="ss-fallback-emoji-grid">
            ${fallbackEmojis.map((e) => `<button class="ss-fallback-emoji-btn" data-emoji="${e}">${e}</button>`).join('')}
          </div>
        `;
        this.pickerElement.querySelectorAll('.ss-fallback-emoji-btn').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            const char = e.currentTarget.getAttribute('data-emoji');
            if (this.onSelect) this.onSelect(char);
          });
        });
      }
    }

    positionPicker(this.pickerElement, anchorElement);
    this.pickerElement.style.display = 'block';
    this.isOpen = true;

    // Click outside listener
    setTimeout(() => {
      const handleOutside = (e) => {
        if (!this.pickerElement?.contains(e.target) && !anchorElement?.contains(e.target)) {
          this.close();
          document.removeEventListener('click', handleOutside);
        }
      };
      document.addEventListener('click', handleOutside);
    }, 50);
  }

  close() {
    if (this.pickerElement) {
      this.pickerElement.style.display = 'none';
    }
    this.isOpen = false;
  }
}

/**
 * StickerPicker Class
 * Fetches sticker packs from /api/chat/stickers and renders tabbed WhatsApp-style grid.
 */
export class StickerPicker {
  constructor(container, onSelect) {
    this.container = container;
    this.onSelect = onSelect;
    this.element = null;
    this.isOpen = false;
    this.packs = [];
    this.activePackId = 'movie';
  }

  async loadPacks() {
    if (this.packs.length > 0) return this.packs;
    try {
      const res = await fetch('/api/chat/stickers');
      if (res.ok) {
        this.packs = await res.json();
      }
    } catch (err) {
      console.warn('[StickerPicker] Failed loading stickers:', err);
    }
    if (!this.packs || !this.packs.length) {
      this.packs = [{ packId: 'movie', name: 'Cinema & Popcorn', count: 12 }];
    }
    return this.packs;
  }

  async open(anchorElement) {
    if (this.isOpen) {
      this.close();
      return;
    }

    await this.loadPacks();

    if (!this.element) {
      this.element = document.createElement('div');
      this.element.className = 'ss-picker-popover ss-sticker-popover';
      document.body.appendChild(this.element);
    }

    this.render();
    positionPicker(this.element, anchorElement);
    this.element.style.display = 'flex';
    this.isOpen = true;

    setTimeout(() => {
      const handleOutside = (e) => {
        if (!this.element?.contains(e.target) && !anchorElement?.contains(e.target)) {
          this.close();
          document.removeEventListener('click', handleOutside);
        }
      };
      document.addEventListener('click', handleOutside);
    }, 50);
  }

  render() {
    const activePack = this.packs.find((p) => p.packId === this.activePackId) || this.packs[0];
    const count = activePack?.count || 12;

    this.element.innerHTML = `
      <div class="ss-sticker-header">
        <span class="ss-picker-title">Stickers</span>
        <button class="ss-picker-close-btn">&times;</button>
      </div>
      <div class="ss-sticker-tabs">
        ${this.packs
          .map(
            (p) => `
          <button class="ss-sticker-tab ${p.packId === this.activePackId ? 'active' : ''}" data-pack="${p.packId}">
            ${escapeHtml(p.name)}
          </button>
        `
          )
          .join('')}
      </div>
      <div class="ss-sticker-grid">
        ${Array.from({ length: count })
          .map(
            (_, i) => `
          <div class="ss-sticker-item" data-pack="${activePack.packId}" data-index="${i}">
            <img src="/stickers/${activePack.packId}/${i}.svg" onerror="this.src='/stickers/${activePack.packId}/${i}.png'" alt="Sticker ${i}" loading="lazy" />
          </div>
        `
          )
          .join('')}
      </div>
    `;

    this.element.querySelector('.ss-picker-close-btn').addEventListener('click', () => this.close());

    this.element.querySelectorAll('.ss-sticker-tab').forEach((tab) => {
      tab.addEventListener('click', (e) => {
        this.activePackId = e.currentTarget.getAttribute('data-pack');
        this.render();
      });
    });

    this.element.querySelectorAll('.ss-sticker-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        const pack = e.currentTarget.getAttribute('data-pack');
        const idx = e.currentTarget.getAttribute('data-index');
        if (this.onSelect) this.onSelect(pack, Number(idx));
        this.close();
      });
    });
  }

  close() {
    if (this.element) {
      this.element.style.display = 'none';
    }
    this.isOpen = false;
  }
}

/**
 * GifPicker Class
 * Tenor GIF search with debounce and trending grid.
 */
export class GifPicker {
  constructor(container, onSelect) {
    this.container = container;
    this.onSelect = onSelect;
    this.element = null;
    this.isOpen = false;
    this.debounceTimer = null;
    this.gifs = [];
  }

  async open(anchorElement) {
    if (this.isOpen) {
      this.close();
      return;
    }

    if (!this.element) {
      this.element = document.createElement('div');
      this.element.className = 'ss-picker-popover ss-gif-popover';
      document.body.appendChild(this.element);
      this.render();
      await this.fetchTrending();
    }

    positionPicker(this.element, anchorElement);
    this.element.style.display = 'flex';
    this.isOpen = true;

    setTimeout(() => {
      const handleOutside = (e) => {
        if (!this.element?.contains(e.target) && !anchorElement?.contains(e.target)) {
          this.close();
          document.removeEventListener('click', handleOutside);
        }
      };
      document.addEventListener('click', handleOutside);
    }, 50);
  }

  render() {
    this.element.innerHTML = `
      <div class="ss-gif-header">
        <input type="text" class="ss-gif-search-input" placeholder="Search Tenor GIFs..." autofocus />
        <button class="ss-picker-close-btn">&times;</button>
      </div>
      <div class="ss-gif-grid" id="ss-gif-grid">
        <div class="ss-gif-loading">Loading trending GIFs...</div>
      </div>
    `;

    this.element.querySelector('.ss-picker-close-btn').addEventListener('click', () => this.close());

    const input = this.element.querySelector('.ss-gif-search-input');
    input.addEventListener('input', (e) => {
      const q = e.target.value.trim();
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        if (q.length > 0) {
          this.searchGifs(q);
        } else {
          this.fetchTrending();
        }
      }, 400);
    });
  }

  async fetchTrending() {
    const grid = this.element.querySelector('#ss-gif-grid');
    try {
      const res = await fetch('/api/chat/gif/trending?limit=24');
      if (res.ok) {
        this.gifs = await res.json();
        this.renderGrid(this.gifs);
      } else {
        if (grid) grid.innerHTML = `<div class="ss-gif-loading" style="color: #94a3b8; padding: 24px; text-align: center;">GIFs unavailable</div>`;
      }
    } catch (err) {
      console.warn('[GifPicker] Failed fetching trending GIFs:', err);
      if (grid) grid.innerHTML = `<div class="ss-gif-loading" style="color: #94a3b8; padding: 24px; text-align: center;">GIFs unavailable</div>`;
    }
  }

  async searchGifs(q) {
    const grid = this.element.querySelector('#ss-gif-grid');
    if (grid) grid.innerHTML = `<div class="ss-gif-loading">Searching "${escapeHtml(q)}"...</div>`;
    try {
      const res = await fetch(`/api/chat/gif/search?q=${encodeURIComponent(q)}&limit=24`);
      if (res.ok) {
        this.gifs = await res.json();
        this.renderGrid(this.gifs);
      } else {
        if (grid) grid.innerHTML = `<div class="ss-gif-loading" style="color: #94a3b8; padding: 24px; text-align: center;">GIFs unavailable</div>`;
      }
    } catch (err) {
      if (grid) grid.innerHTML = `<div class="ss-gif-loading" style="color: #94a3b8; padding: 24px; text-align: center;">GIFs unavailable</div>`;
    }
  }

  renderGrid(gifs) {
    const grid = this.element.querySelector('#ss-gif-grid');
    if (!grid) return;
    if (!gifs || gifs.length === 0) {
      grid.innerHTML = `<div class="ss-gif-loading" style="color: #94a3b8; padding: 24px; text-align: center;">No GIFs found.</div>`;
      return;
    }

    grid.innerHTML = gifs
      .map(
        (g) => {
          const rawUrl = g.preview || g.url;
          const proxiedUrl = `/api/chat/gif/proxy?url=${encodeURIComponent(rawUrl)}`;
          const w = g.width || 200;
          const h = g.height || 112;
          return `
          <div class="ss-gif-item" data-url="${escapeHtml(g.url)}">
            <img src="${proxiedUrl}" alt="GIF" width="${w}" height="${h}" loading="lazy" />
          </div>
        `;
        }
      )
      .join('');

    grid.querySelectorAll('.ss-gif-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        const url = e.currentTarget.getAttribute('data-url');
        if (this.onSelect) this.onSelect(url);
        this.close();
      });
    });
  }

  close() {
    if (this.element) {
      this.element.style.display = 'none';
    }
    this.isOpen = false;
  }
}

/**
 * ReplyBar Class
 * Manages the floating quoted reply banner above the chat input.
 */
export class ReplyBar {
  constructor(container, onClear) {
    this.container = container;
    this.onClear = onClear;
    this.activeReply = null;
    this.element = null;
    this.init();
  }

  init() {
    this.element = document.createElement('div');
    this.element.className = 'ss-reply-bar';
    this.element.style.display = 'none';
    this.element.innerHTML = `
      <div class="ss-reply-indicator"></div>
      <div class="ss-reply-content">
        <span class="ss-reply-author"></span>
        <span class="ss-reply-snippet"></span>
      </div>
      <button class="ss-reply-close-btn" title="Cancel Reply">&times;</button>
    `;
    this.container.prepend(this.element);

    this.element.querySelector('.ss-reply-close-btn').addEventListener('click', () => {
      this.clear();
      if (this.onClear) this.onClear();
    });
  }

  setReply(message) {
    this.activeReply = message;
    if (!message) {
      this.clear();
      return;
    }

    const authorEl = this.element.querySelector('.ss-reply-author');
    const snippetEl = this.element.querySelector('.ss-reply-snippet');

    authorEl.textContent = `Replying to ${message.user?.name || 'Peer'}`;

    let textPreview = message.text || '';
    if (message.type === 'sticker') textPreview = '🎭 Sticker';
    else if (message.type === 'gif') textPreview = '🎞️ GIF';
    else if (message.type === 'image') textPreview = '🖼️ Photo';
    else if (message.type === 'file') textPreview = `📄 ${message.attachment?.name || 'File'}`;

    snippetEl.textContent = textPreview.slice(0, 60);
    this.element.style.display = 'flex';
  }

  clear() {
    this.activeReply = null;
    this.element.style.display = 'none';
  }
}

/**
 * AttachmentHandler Class
 * Client-side canvas compression for photos (<800px) and 5MB size guard.
 */
export class AttachmentHandler {
  constructor(onAttachmentReady, showToast) {
    this.onAttachmentReady = onAttachmentReady;
    this.showToast = showToast || alert;
    this.inputElement = document.createElement('input');
    this.inputElement.type = 'file';
    this.inputElement.accept = 'image/*,video/*,.pdf,.txt,.zip,.mp3';
    this.inputElement.style.display = 'none';
    document.body.appendChild(this.inputElement);

    this.inputElement.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) {
        this.processFile(file);
      }
      this.inputElement.value = '';
    });
  }

  open() {
    this.inputElement.click();
  }

  async processFile(file) {
    const MAX_SIZE = 5 * 1024 * 1024; // 5MB limit
    if (file.size > MAX_SIZE) {
      this.showToast('File too large — maximum limit is 5MB.');
      return false;
    }

    const isImage = file.type.startsWith('image/');

    if (isImage) {
      try {
        const compressed = await this.compressImage(file);
        if (this.onAttachmentReady) {
          this.onAttachmentReady({
            type: 'image',
            name: file.name,
            size: compressed.size,
            mimeType: file.type || 'image/jpeg',
            url: compressed.dataUrl,
            thumbnailUrl: compressed.dataUrl,
          });
        }
        return true;
      } catch (err) {
        console.warn('[AttachmentHandler] Canvas compression fallback:', err);
      }
    }

    // Generic file or uncompressed fallback
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target.result;
        if (this.onAttachmentReady) {
          this.onAttachmentReady({
            type: isImage ? 'image' : 'file',
            name: file.name,
            size: file.size,
            mimeType: file.type || 'application/octet-stream',
            url: dataUrl,
          });
        }
        resolve(true);
      };
      reader.readAsDataURL(file);
    });
  }

  compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const maxDim = 800;
          let width = img.width;
          let height = img.height;

          if (width > maxDim || height > maxDim) {
            if (width > height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
          // Estimate byte size from base64 length
          const estimatedSize = Math.round((dataUrl.length * 3) / 4);
          resolve({ dataUrl, size: estimatedSize });
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
}

/**
 * RichChatMessage Renderer
 * Pure rendering function for WhatsApp-style chat bubbles, reactions, and cards.
 */
export function renderRichChatMessage(msg, currentUserId, messageHistory, onReaction, onReply, onImageClick) {
  const isMe = msg.user?.id === currentUserId;
  const item = document.createElement('div');
  item.className = `ss-chat-msg ${isMe ? 'is-me' : 'is-peer'}`;
  item.id = `chat-${msg.id}`;
  item.setAttribute('data-msg-id', msg.id);

  // 1. Quoted Reply Card
  let quotedHtml = '';
  if (msg.replyTo) {
    const orig = typeof msg.replyTo === 'object' ? msg.replyTo : messageHistory.get(msg.replyTo);
    if (!orig) {
      quotedHtml = `
        <div class="ss-quoted-card missing">
          <span class="ss-quoted-name">Message not available</span>
          <span class="ss-quoted-text" style="font-style: italic; opacity: 0.7;">Message not available</span>
        </div>
      `;
    } else {
      const origName = orig?.user?.name || orig?.userName || 'Peer';
      let origText = orig?.text || orig?.textPreview || '';
      if (!origText && orig?.type === 'sticker') origText = '🎭 Sticker';
      if (!origText && orig?.type === 'gif') origText = '🎞️ GIF';
      if (!origText && orig?.type === 'image') origText = '🖼️ Photo';
      if (!origText && orig?.type === 'file') origText = `📄 ${orig?.attachment?.name || 'File'}`;

      quotedHtml = `
        <div class="ss-quoted-card" data-orig-id="${escapeHtml(orig?.id || '')}">
          <span class="ss-quoted-name">${escapeHtml(origName)}</span>
          <span class="ss-quoted-text">${escapeHtml(origText || 'Original message')}</span>
        </div>
      `;
    }
  }

  // 2. Primary Content according to Type
  let contentHtml = '';
  switch (msg.type) {
    case 'sticker':
      const [packId = 'movie', index = 0] = (msg.stickerId || 'movie:0').split(':');
      contentHtml = `
        <div class="ss-sticker-wrap">
          <img src="/stickers/${escapeHtml(packId)}/${escapeHtml(index)}.svg" onerror="this.src='/stickers/${escapeHtml(packId)}/${escapeHtml(index)}.png'" class="ss-sticker-img" alt="Sticker" />
        </div>
      `;
      break;

    case 'gif':
      contentHtml = `
        <div class="ss-gif-wrap">
          <img src="${escapeHtml(msg.gifUrl || '')}" class="ss-gif-img" loading="lazy" alt="GIF" />
        </div>
      `;
      break;

    case 'image':
      const imgUrl = msg.attachment?.url || '';
      contentHtml = `
        <div class="ss-image-card">
          <img src="${escapeHtml(imgUrl)}" class="ss-attachment-img" alt="${escapeHtml(msg.attachment?.name || 'Photo')}" loading="lazy" />
        </div>
      `;
      break;

    case 'file':
      const f = msg.attachment || {};
      contentHtml = `
        <div class="ss-file-card">
          <div class="ss-file-icon">📄</div>
          <div class="ss-file-info">
            <span class="ss-file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name || 'document.pdf')}</span>
            <span class="ss-file-meta">${formatBytes(f.size)} • ${escapeHtml(f.mimeType || 'file')}</span>
          </div>
          <a href="${escapeHtml(f.url)}" download="${escapeHtml(f.name || 'download')}" class="ss-file-download-btn">⬇️</a>
        </div>
      `;
      break;

    case 'text':
    default:
      contentHtml = `<span class="ss-msg-text">${escapeHtml(msg.text || msg.content || '')}</span>`;
      break;
  }

  // 3. Reactions Row
  let reactionsHtml = '';
  if (msg.reactions && Object.keys(msg.reactions).length > 0) {
    reactionsHtml = `
      <div class="ss-reactions-bar">
        ${Object.entries(msg.reactions)
          .map(([emoji, users]) => {
            if (!users || users.length === 0) return '';
            const iReacted = users.includes(currentUserId);
            return `
              <button class="ss-reaction-chip ${iReacted ? 'active' : ''}" data-emoji="${escapeHtml(emoji)}">
                <span>${emoji}</span>
                <span class="ss-reaction-count">${users.length}</span>
              </button>
            `;
          })
          .join('')}
      </div>
    `;
  }

  // 4. Quick-Hover Action Bar
  const quickBar = `
    <div class="ss-hover-actions">
      <button class="ss-quick-react-btn" data-emoji="❤️">❤️</button>
      <button class="ss-quick-react-btn" data-emoji="😂">😂</button>
      <button class="ss-quick-react-btn" data-emoji="😮">😮</button>
      <button class="ss-quick-react-btn" data-emoji="🔥">🔥</button>
      <button class="ss-quick-react-btn" data-emoji="👍">👍</button>
      <button class="ss-quick-reply-btn" title="Reply">↩️</button>
    </div>
  `;

  const timeStr = new Date(msg.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  item.innerHTML = `
    ${quickBar}
    <div class="ss-bubble">
      ${!isMe ? `<span class="ss-sender-name">${escapeHtml(msg.user?.name || 'Peer')}</span>` : ''}
      ${quotedHtml}
      ${contentHtml}
      <div class="ss-bubble-footer">
        <span class="ss-timestamp">${timeStr}</span>
      </div>
      ${reactionsHtml}
    </div>
  `;

  // Bind Event Listeners
  item.querySelectorAll('.ss-quick-react-btn, .ss-reaction-chip').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const emoji = btn.getAttribute('data-emoji');
      if (onReaction) onReaction(msg.id, emoji);
    });
  });

  const replyBtn = item.querySelector('.ss-quick-reply-btn');
  if (replyBtn) {
    replyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onReply) onReply(msg);
    });
  }

  const quotedCard = item.querySelector('.ss-quoted-card');
  if (quotedCard) {
    quotedCard.addEventListener('click', () => {
      const origId = quotedCard.getAttribute('data-orig-id');
      if (origId) {
        const target = document.getElementById(`chat-${origId}`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('ss-highlight-pulse');
          setTimeout(() => target.classList.remove('ss-highlight-pulse'), 1500);
        }
      }
    });
  }

  const imgCard = item.querySelector('.ss-attachment-img');
  if (imgCard) {
    imgCard.addEventListener('click', () => {
      if (onImageClick) onImageClick(imgCard.src);
    });
  }

  return item;
}

/**
 * RichChat Class (Main Export)
 * Full lifecycle controller for StreamSync rich chat.
 */
export default class RichChat {
  constructor(container, wsClient, currentUser = { id: 'u_local', name: 'You' }) {
    this.container = container;
    this.ws = wsClient;
    this.currentUser = currentUser;
    this.messageHistory = new Map();
    this.activeReply = null;

    this.emojiPicker = null;
    this.stickerPicker = null;
    this.gifPicker = null;
    this.replyBar = null;
    this.attachmentHandler = null;

    this.injectStyles();
  }

  injectStyles() {
    if (document.getElementById('ss-rich-chat-styles')) return;
    const style = document.createElement('style');
    style.id = 'ss-rich-chat-styles';
    style.textContent = `
      .ss-chat-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: #0f172a;
        color: #f1f5f9;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        position: relative;
        overflow: hidden;
      }
      .ss-messages-list {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        scroll-behavior: smooth;
      }
      .ss-chat-msg {
        display: flex;
        position: relative;
        max-width: 82%;
        animation: ssSlideUp 0.18s ease-out;
      }
      @keyframes ssSlideUp {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .ss-chat-msg.is-me {
        align-self: flex-end;
      }
      .ss-chat-msg.is-peer {
        align-self: flex-start;
      }
      .ss-bubble {
        padding: 8px 12px;
        border-radius: 14px;
        position: relative;
        font-size: 13.5px;
        line-height: 1.45;
        box-shadow: 0 1px 3px rgba(0,0,0,0.3);
      }
      .ss-chat-msg.is-me .ss-bubble {
        background: #3b82f6;
        color: #ffffff;
        border-bottom-right-radius: 3px;
      }
      .ss-chat-msg.is-peer .ss-bubble {
        background: #1e293b;
        color: #f8fafc;
        border-bottom-left-radius: 3px;
      }
      .ss-sender-name {
        font-size: 11px;
        font-weight: 700;
        color: #38bdf8;
        margin-bottom: 2px;
        display: block;
      }
      .ss-bubble-footer {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 4px;
        margin-top: 3px;
      }
      .ss-timestamp {
        font-size: 10px;
        opacity: 0.65;
      }
      /* Quoted Reply */
      .ss-quoted-card {
        background: rgba(0, 0, 0, 0.22);
        border-left: 3px solid #38bdf8;
        border-radius: 6px;
        padding: 4px 8px;
        margin-bottom: 6px;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        font-size: 11.5px;
      }
      .ss-chat-msg.is-me .ss-quoted-card {
        border-left-color: #fde047;
      }
      .ss-quoted-name {
        font-weight: 700;
        color: #38bdf8;
      }
      .ss-chat-msg.is-me .ss-quoted-name {
        color: #fde047;
      }
      .ss-quoted-text {
        color: #cbd5e1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      /* Stickers & GIFs */
      .ss-sticker-wrap, .ss-gif-wrap {
        border-radius: 10px;
        overflow: hidden;
        margin: 2px 0;
      }
      .ss-sticker-img {
        width: 110px;
        height: 110px;
        object-fit: contain;
      }
      .ss-gif-img {
        max-width: 210px;
        max-height: 160px;
        border-radius: 8px;
        display: block;
      }
      /* Image & File Attachments */
      .ss-attachment-img {
        max-width: 220px;
        max-height: 180px;
        border-radius: 8px;
        cursor: pointer;
        display: block;
        transition: transform 0.15s ease;
      }
      .ss-attachment-img:hover {
        transform: scale(1.02);
      }
      .ss-file-card {
        display: flex;
        align-items: center;
        gap: 10px;
        background: rgba(0,0,0,0.25);
        padding: 8px 10px;
        border-radius: 8px;
      }
      .ss-file-icon {
        font-size: 24px;
      }
      .ss-file-info {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
      }
      .ss-file-name {
        font-weight: 600;
        font-size: 12px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ss-file-meta {
        font-size: 10px;
        opacity: 0.7;
      }
      .ss-file-download-btn {
        background: rgba(255,255,255,0.15);
        border-radius: 6px;
        padding: 4px 8px;
        text-decoration: none;
        color: #fff;
        font-size: 14px;
      }
      /* Reactions */
      .ss-reactions-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 5px;
      }
      .ss-reaction-chip {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        background: rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 12px;
        padding: 2px 6px;
        font-size: 11px;
        cursor: pointer;
        color: #fff;
        transition: all 0.12s;
      }
      .ss-reaction-chip.active {
        background: rgba(59, 130, 246, 0.4);
        border-color: #3b82f6;
      }
      /* Hover Quick Bar */
      .ss-hover-actions {
        position: absolute;
        top: -14px;
        right: 8px;
        background: #1e293b;
        border: 1px solid #334155;
        border-radius: 16px;
        padding: 2px 6px;
        display: none;
        align-items: center;
        gap: 4px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        z-index: 10;
      }
      .ss-chat-msg:hover .ss-hover-actions {
        display: flex;
      }
      .ss-quick-react-btn, .ss-quick-reply-btn {
        background: none;
        border: none;
        font-size: 13px;
        cursor: pointer;
        padding: 2px;
        border-radius: 4px;
        transition: transform 0.1s;
      }
      .ss-quick-react-btn:hover, .ss-quick-reply-btn:hover {
        transform: scale(1.25);
      }
      .ss-highlight-pulse {
        animation: ssPulse 1.2s ease;
      }
      @keyframes ssPulse {
        0%, 100% { outline: none; }
        50% { outline: 2px solid #6366f1; background: rgba(99, 102, 241, 0.2); }
      }
      /* Input Bar & Controls */
      .ss-chat-footer {
        background: #0f172a;
        border-top: 1px solid #1e293b;
        display: flex;
        flex-direction: column;
        position: relative;
      }
      .ss-reply-bar {
        background: #1e293b;
        border-left: 3px solid #3b82f6;
        padding: 6px 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 12px;
      }
      .ss-reply-content {
        display: flex;
        flex-direction: column;
        flex: 1;
        overflow: hidden;
      }
      .ss-reply-author {
        font-weight: 700;
        color: #38bdf8;
      }
      .ss-reply-snippet {
        color: #94a3b8;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ss-reply-close-btn {
        background: none;
        border: none;
        color: #94a3b8;
        font-size: 16px;
        cursor: pointer;
      }
      .ss-input-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
      }
      .ss-input-field {
        flex: 1;
        background: #1e293b;
        border: 1px solid #334155;
        border-radius: 20px;
        padding: 8px 14px;
        color: #fff;
        font-size: 13.5px;
        outline: none;
      }
      .ss-input-field:focus {
        border-color: #3b82f6;
      }
      .ss-tool-btn {
        background: none;
        border: none;
        font-size: 18px;
        color: #94a3b8;
        cursor: pointer;
        padding: 4px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.15s;
      }
      .ss-tool-btn:hover {
        color: #38bdf8;
      }
      .ss-send-btn {
        background: #3b82f6;
        color: #fff;
        border: none;
        border-radius: 50%;
        width: 34px;
        height: 34px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 14px;
        transition: transform 0.12s;
      }
      .ss-send-btn:hover {
        transform: scale(1.06);
      }
      /* Popovers - Body Mounted & Z-Index Stack */
      .ss-picker-popover {
        position: fixed !important;
        background: #1e293b !important;
        border: 1px solid #334155 !important;
        border-radius: 14px !important;
        box-shadow: 0 12px 35px rgba(0, 0, 0, 0.75) !important;
        display: none;
        flex-direction: column !important;
        overflow: hidden !important;
        box-sizing: border-box !important;
      }
      .ss-emoji-popover {
        z-index: 300 !important;
      }
      .ss-sticker-popover {
        z-index: 301 !important;
      }
      .ss-gif-popover {
        z-index: 302 !important;
      }

      /* Momentum Touch Scrolling */
      .scrollable-panel,
      .ss-sticker-grid,
      .ss-gif-grid {
        overflow-y: auto !important;
        -webkit-overflow-scrolling: touch !important;
        overscroll-behavior: contain !important;
        scroll-behavior: smooth !important;
        touch-action: pan-y !important;
      }

      .ss-picker-title {
        font-weight: 700;
        font-size: 13px;
        color: #f1f5f9;
      }
      .ss-picker-close-btn {
        background: none;
        border: none;
        color: #94a3b8;
        font-size: 18px;
        cursor: pointer;
      }
      .ss-fallback-emoji-grid {
        display: grid;
        grid-template-columns: repeat(8, minmax(0, 1fr));
        gap: 6px;
        padding: 12px;
      }
      .ss-fallback-emoji-btn {
        background: none;
        border: none;
        font-size: 20px;
        cursor: pointer;
      }
      /* Sticker Popover */
      .ss-sticker-header, .ss-gif-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        border-bottom: 1px solid #334155;
      }
      .ss-sticker-tabs {
        display: flex;
        gap: 4px;
        padding: 6px 10px;
        background: #0f172a;
        overflow-x: auto;
      }
      .ss-sticker-tab {
        background: none;
        border: 1px solid #334155;
        color: #cbd5e1;
        border-radius: 12px;
        padding: 3px 8px;
        font-size: 11px;
        cursor: pointer;
        white-space: nowrap;
      }
      .ss-sticker-tab.active {
        background: #3b82f6;
        color: #fff;
        border-color: #3b82f6;
      }
      .ss-sticker-grid {
        display: grid !important;
        grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)) !important;
        gap: 8px !important;
        padding: 10px !important;
        max-height: 260px !important;
      }
      .ss-sticker-item {
        cursor: pointer;
        border-radius: 8px;
        padding: 6px;
        text-align: center;
        transition: background 0.12s;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .ss-sticker-item:hover {
        background: rgba(255,255,255,0.08);
      }
      .ss-sticker-item img {
        width: 60px;
        height: 60px;
        object-fit: contain;
      }
      /* GIF Popover */
      .ss-gif-search-input {
        flex: 1;
        background: #0f172a;
        border: 1px solid #334155;
        border-radius: 8px;
        padding: 6px 10px;
        color: #fff;
        font-size: 12px;
        margin-right: 8px;
      }
      .ss-gif-grid {
        display: grid !important;
        grid-template-columns: repeat(auto-fill, minmax(105px, 1fr)) !important;
        gap: 8px !important;
        padding: 8px !important;
        max-height: 280px !important;
      }
      .ss-gif-item {
        aspect-ratio: 16/9 !important;
        border-radius: 6px !important;
        overflow: hidden !important;
        cursor: pointer !important;
        background: rgba(255, 255, 255, 0.05) !important;
        position: relative !important;
      }
      .ss-gif-item img {
        width: 100% !important;
        height: 100% !important;
        object-fit: cover !important;
        display: block !important;
      }
      .ss-gif-loading {
        grid-column: 1 / -1;
        text-align: center;
        color: #94a3b8;
        padding: 24px;
        font-size: 12px;
      }
      /* Lightbox Modal */
      .ss-lightbox {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.88);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        cursor: zoom-out;
      }
      .ss-lightbox img {
        max-width: 90vw;
        max-height: 90vh;
        border-radius: 8px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.8);
      }

      /* Mobile Chat & Pickers Responsiveness */
      @media (max-width: 600px) {
        .ss-input-bar {
          padding: 6px 8px !important;
          gap: 4px !important;
          width: 100% !important;
          box-sizing: border-box !important;
        }
        .ss-tool-btn {
          font-size: 16px !important;
          padding: 6px !important;
          min-width: 44px !important;
          min-height: 44px !important;
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          touch-action: manipulation !important;
        }
        .ss-tool-btn#ss-btn-gif {
          font-size: 12px !important;
          font-weight: 800 !important;
        }
        .ss-input-field {
          padding: 8px 12px !important;
          font-size: 13px !important;
          min-width: 0 !important;
          min-height: 44px !important;
        }
        .ss-send-btn {
          width: 44px !important;
          height: 44px !important;
          min-width: 44px !important;
          min-height: 44px !important;
          font-size: 14px !important;
          flex-shrink: 0 !important;
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          touch-action: manipulation !important;
        }
        .ss-sticker-grid {
          grid-template-columns: repeat(auto-fill, minmax(75px, 1fr)) !important;
          gap: 6px !important;
          padding: 6px !important;
          max-height: 220px !important;
        }
        .ss-sticker-item img {
          width: 50px !important;
          height: 50px !important;
        }
        .ss-gif-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
        }
        em-emoji-picker {
          width: 100% !important;
          max-width: 100% !important;
          height: 260px !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  async init() {
    this.renderShell();

    // Initialize Subcomponents
    this.emojiPicker = new EmojiPicker((emoji) => {
      const input = this.container.querySelector('#ss-chat-input');
      const start = input.selectionStart || input.value.length;
      const end = input.selectionEnd || input.value.length;
      input.value = input.value.substring(0, start) + emoji + input.value.substring(end);
      input.focus();
      input.selectionStart = input.selectionEnd = start + emoji.length;
    });
    await this.emojiPicker.init(this.container.querySelector('.ss-chat-footer'));

    this.stickerPicker = new StickerPicker(this.container.querySelector('.ss-chat-footer'), (packId, index) => {
      this.sendSticker(packId, index);
    });

    this.gifPicker = new GifPicker(this.container.querySelector('.ss-chat-footer'), (gifUrl) => {
      this.sendGif(gifUrl);
    });

    this.replyBar = new ReplyBar(this.container.querySelector('.ss-chat-footer'), () => {
      this.activeReply = null;
    });

    this.attachmentHandler = new AttachmentHandler(
      (attachment) => {
        this.sendAttachment(attachment);
      },
      (msg) => alert(msg)
    );

    this.bindEvents();
  }

  renderShell() {
    this.container.innerHTML = `
      <div class="ss-chat-container">
        <div class="ss-messages-list" id="ss-messages-list">
          <div class="ss-chat-empty-state" id="ss-chat-empty-state" style="text-align: center; margin: auto; padding: 24px 16px; color: #64748b; font-size: 12px; pointer-events: none;">
            <div style="font-size: 28px; margin-bottom: 6px;">🍿</div>
            <div style="font-weight: 700; color: #cbd5e1; font-size: 13.5px;">Watch Party Chat</div>
            <div style="margin-top: 4px; font-size: 11px; color: #94a3b8;">Send messages, movie stickers, reactions, or GIFs in real-time!</div>
          </div>
        </div>
        <div class="ss-chat-footer">
          <div class="ss-input-bar">
            <button class="ss-tool-btn" id="ss-btn-emoji" title="Emojis">😊</button>
            <button class="ss-tool-btn" id="ss-btn-sticker" title="Stickers">🎭</button>
            <button class="ss-tool-btn" id="ss-btn-gif" title="GIFs" style="font-size: 13px; font-weight: 800;">GIF</button>
            <button class="ss-tool-btn" id="ss-btn-attach" title="Attach file">📎</button>
            <input type="text" class="ss-input-field" id="ss-chat-input" placeholder="Type a message..." maxlength="500" />
            <button class="ss-send-btn" id="ss-btn-send" title="Send">➤</button>
          </div>
        </div>
      </div>
    `;
  }

  bindEvents() {
    const input = this.container.querySelector('#ss-chat-input');
    const sendBtn = this.container.querySelector('#ss-btn-send');

    sendBtn.addEventListener('click', () => this.send());

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send();
      } else if (e.key === 'Escape') {
        this.replyBar.clear();
        this.activeReply = null;
      }
    });

    this.container.querySelector('#ss-btn-emoji').addEventListener('click', (e) => {
      this.emojiPicker.open(e.currentTarget);
    });

    this.container.querySelector('#ss-btn-sticker').addEventListener('click', (e) => {
      this.stickerPicker.open(e.currentTarget);
    });

    this.container.querySelector('#ss-btn-gif').addEventListener('click', (e) => {
      this.gifPicker.open(e.currentTarget);
    });

    this.container.querySelector('#ss-btn-attach').addEventListener('click', () => {
      this.attachmentHandler.open();
    });
  }

  send() {
    const input = this.container.querySelector('#ss-chat-input');
    const text = input.value.trim();
    if (!text) return;

    const message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      user: this.currentUser,
      type: 'text',
      text,
      timestamp: Date.now(),
      ...(this.activeReply ? { replyTo: this.activeReply.id } : {}),
    };

    this.emitMessage(message);
    input.value = '';
    this.replyBar.clear();
    this.activeReply = null;
  }

  sendSticker(packId, index) {
    const message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      user: this.currentUser,
      type: 'sticker',
      stickerId: `${packId}:${index}`,
      timestamp: Date.now(),
      ...(this.activeReply ? { replyTo: this.activeReply.id } : {}),
    };
    this.emitMessage(message);
    this.replyBar.clear();
    this.activeReply = null;
  }

  sendGif(gifUrl) {
    const message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      user: this.currentUser,
      type: 'gif',
      gifUrl,
      timestamp: Date.now(),
      ...(this.activeReply ? { replyTo: this.activeReply.id } : {}),
    };
    this.emitMessage(message);
    this.replyBar.clear();
    this.activeReply = null;
  }

  sendAttachment(attachment) {
    const message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      user: this.currentUser,
      type: attachment.type || 'file',
      attachment,
      timestamp: Date.now(),
      ...(this.activeReply ? { replyTo: this.activeReply.id } : {}),
    };
    this.emitMessage(message);
    this.replyBar.clear();
    this.activeReply = null;
  }

  emitMessage(message) {
    // If WebSocket is open, send to peers
    if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === WebSocket.OPEN)) {
      this.ws.send(JSON.stringify({ type: 'chat', chat: message }));
    } else {
      // Local fallback for offline/preview
      this.receive(message);
    }
  }

  toggleReaction(targetMsgId, emoji) {
    if (!this._reactionDebounce) this._reactionDebounce = new Map();
    const key = `${targetMsgId}:${emoji}`;
    const now = Date.now();
    if (this._reactionDebounce.has(key) && (now - this._reactionDebounce.get(key) < 300)) {
      return; // prevent rapid spam-clicking
    }
    this._reactionDebounce.set(key, now);

    const reactionMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      user: this.currentUser,
      type: 'emoji_reaction',
      text: emoji,
      replyTo: targetMsgId,
      timestamp: Date.now(),
    };
    this.emitMessage(reactionMessage);
  }

  receive(raw) {
    // Normalize payload
    let msg = raw.chat || raw;
    if (!msg.id) msg.id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    if (!msg.user) msg.user = { id: raw.user_id || 'peer', name: raw.display_name || 'Peer' };
    if (!msg.type) msg.type = 'text';
    if (!msg.text && raw.content) msg.text = raw.content;

    // Handle reaction aggregation
    if (msg.type === 'emoji_reaction' && msg.replyTo) {
      const targetId = typeof msg.replyTo === 'object' ? msg.replyTo.id : msg.replyTo;
      const targetMsg = this.messageHistory.get(targetId);
      if (targetMsg) {
        if (!targetMsg.reactions) targetMsg.reactions = {};
        const emoji = msg.text;
        const users = targetMsg.reactions[emoji] || [];
        const senderId = msg.user.id;
        const idx = users.indexOf(senderId);

        if (idx !== -1) {
          users.splice(idx, 1);
          if (users.length === 0) delete targetMsg.reactions[emoji];
        } else {
          users.push(senderId);
          targetMsg.reactions[emoji] = Array.from(new Set(users));
        }

        // Re-render target message element in DOM
        const existingEl = document.getElementById(`chat-${targetId}`);
        if (existingEl) {
          const updatedEl = renderRichChatMessage(
            targetMsg,
            this.currentUser.id,
            this.messageHistory,
            (tId, emo) => this.toggleReaction(tId, emo),
            (m) => {
              this.activeReply = m;
              this.replyBar.setReply(m);
            },
            (src) => this.openLightbox(src)
          );
          existingEl.replaceWith(updatedEl);
        }
      }
      return;
    }

    this.messageHistory.set(msg.id, msg);

    const emptyState = this.container.querySelector('#ss-chat-empty-state');
    if (emptyState) emptyState.remove();

    const list = this.container.querySelector('#ss-messages-list');
    if (!list) return;

    const el = renderRichChatMessage(
      msg,
      this.currentUser.id,
      this.messageHistory,
      (tId, emo) => this.toggleReaction(tId, emo),
      (m) => {
        this.activeReply = m;
        this.replyBar.setReply(m);
      },
      (src) => this.openLightbox(src)
    );

    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
  }

  openLightbox(src) {
    const lightbox = document.createElement('div');
    lightbox.className = 'ss-lightbox';
    lightbox.innerHTML = `<img src="${escapeHtml(src)}" alt="Enlarged" />`;
    lightbox.addEventListener('click', () => lightbox.remove());
    document.body.appendChild(lightbox);
  }
}


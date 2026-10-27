/**
 * StreamSync - Party Player Client Module
 * 
 * Manages video playback, Hls.js lifecycle, subtitle tracks,
 * dual-threshold drift correction, and WebSocket party sync.
 */

export function getDriftAction(currentMs, targetMs, isPaused = false) {
  const deltaMs = targetMs - currentMs;
  const absDeltaMs = Math.abs(deltaMs);

  if (absDeltaMs >= 5000) {
    return { type: 'seek', targetMs, targetSec: targetMs / 1000, deltaMs };
  } else if (absDeltaMs >= 500 && !isPaused) {
    return { type: 'rate', rate: deltaMs > 0 ? 1.05 : 0.95, deltaMs };
  }
  return { type: 'rate', rate: 1.0, deltaMs };
}

export class PartyPlayer {
  /**
   * @param {HTMLVideoElement|string} videoEl 
   * @param {Object} options
   * @param {(msg: any) => void} options.wsSend
   * @param {() => number} [options.getNtpNow]
   * @param {HTMLElement} [options.container]
   */
  constructor(videoEl, options = {}) {
    this.video = typeof videoEl === 'string' ? document.querySelector(videoEl) : videoEl;
    if (!this.video) {
      throw new Error('PartyPlayer requires a valid video element');
    }

    this.wsSend = options.wsSend || (() => {});
    this.getNtpNow = options.getNtpNow || (() => Date.now());
    this.container = options.container || this.video.parentElement || document.body;

    // REF guard to prevent echo loops during remote sync (CRITICAL: MUST BE A REF)
    this.isRemoteSync = { current: false };

    // Internal HLS instance
    this.hls = null;
    this.isHlsManifestLoaded = false;

    // Timeline sync state
    this.syncState = {
      status: 'PAUS',
      position: 0,
      time: 0,
      started: null,
      paused: 0,
      rate: 1.0
    };

    // Current loaded video metadata
    this.currentVideo = null;

    // Drift loop control
    this.driftRafId = null;
    this.lastDriftCheck = 0;
    this.isDriftRunning = false;

    // Subtitle track
    this.trackEl = null;

    // Create overlays
    this._injectStyles();
    this._createOverlays();

    // Attach local video event listeners
    this._bindVideoEvents();
  }

  _injectStyles() {
    if (document.getElementById('party-player-styles')) return;
    const style = document.createElement('style');
    style.id = 'party-player-styles';
    style.textContent = `
      .stream-overlay-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(9, 13, 22, 0.88);
        backdrop-filter: blur(16px);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        z-index: 50;
        color: #f8fafc;
        font-family: 'Inter', -apple-system, sans-serif;
        padding: 24px;
        text-align: center;
        transition: opacity 0.3s ease;
      }
      .stream-loading-spinner {
        width: 48px;
        height: 48px;
        border: 4px solid rgba(59, 130, 246, 0.2);
        border-top-color: #3b82f6;
        border-radius: 50%;
        animation: stream-spin 1s linear infinite;
        margin-bottom: 20px;
      }
      @keyframes stream-spin {
        to { transform: rotate(360deg); }
      }
      .stream-overlay-title {
        font-family: 'Outfit', sans-serif;
        font-size: 22px;
        font-weight: 700;
        margin-bottom: 8px;
      }
      .stream-overlay-sub {
        font-size: 14px;
        color: #94a3b8;
        max-width: 400px;
      }
      .stream-countdown {
        font-family: 'Outfit', sans-serif;
        font-size: 72px;
        font-weight: 800;
        background: linear-gradient(135deg, #3b82f6, #60a5fa);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        animation: stream-pulse 1s ease-in-out infinite;
      }
      @keyframes stream-pulse {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.1); }
      }
    `;
    document.head.appendChild(style);
  }

  _createOverlays() {
    // Loading overlay
    this.loadingOverlay = document.createElement('div');
    this.loadingOverlay.className = 'stream-overlay-backdrop';
    this.loadingOverlay.style.display = 'none';
    this.loadingOverlay.innerHTML = `
      <div class="stream-loading-spinner"></div>
      <div class="stream-overlay-title" id="party-loader-title">Finding best stream...</div>
      <div class="stream-overlay-sub" id="party-loader-sub">Negotiating token with Streamo CDN network</div>
    `;
    this.container.appendChild(this.loadingOverlay);

    // Countdown overlay
    this.countdownOverlay = document.createElement('div');
    this.countdownOverlay.className = 'stream-overlay-backdrop';
    this.countdownOverlay.style.display = 'none';
    this.countdownOverlay.innerHTML = `
      <div class="stream-overlay-sub" style="margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700;">Starting In</div>
      <div class="stream-countdown" id="party-countdown-num">3</div>
    `;
    this.container.appendChild(this.countdownOverlay);
  }

  showLoading(title = 'Finding best stream...', sub = 'Negotiating token with Streamo CDN network') {
    if (this.loadingOverlay) {
      document.getElementById('party-loader-title').textContent = title;
      document.getElementById('party-loader-sub').textContent = sub;
      this.loadingOverlay.style.display = 'flex';
    }
  }

  hideLoading() {
    if (this.loadingOverlay) {
      this.loadingOverlay.style.display = 'none';
    }
  }

  async showCountdown(seconds = 3) {
    if (!this.countdownOverlay) return;
    this.countdownOverlay.style.display = 'flex';
    const numEl = document.getElementById('party-countdown-num');

    for (let i = seconds; i > 0; i--) {
      numEl.textContent = i;
      await new Promise(r => setTimeout(r, 900));
    }

    this.countdownOverlay.style.display = 'none';
  }

  /**
   * Load a movie/show from the Streamo streaming pipeline
   * @param {Object} movie
   * @param {number|string} movie.tmdbId
   * @param {string} [movie.type='movie']
   * @param {string} [movie.title]
   * @param {string} [movie.poster]
   * @param {number} [movie.season=1]
   * @param {number} [movie.episode=1]
   */
  async loadStream(movie) {
    const tmdbId = movie.tmdbId;
    const type = movie.type || 'movie';
    const title = movie.title || 'Selected Title';

    this.showLoading(`Finding best stream for ${title}...`, 'Connecting to Streamo streaming pipeline...');

    try {
      const season = movie.season || 1;
      const episode = movie.episode || 1;
      const queryParams = type === 'tv' 
        ? `type=tv&season=${season}&episode=${episode}`
        : 'type=movie';

      // Step 1: Fetch stream
      const res = await fetch(`/api/media/stream/${tmdbId}?${queryParams}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Failed to resolve stream (HTTP ${res.status})`);
      }
      const data = await res.json();
      const streamUrl = data.streamUrl;
      const provider = data.provider || 'streamo';

      // Step 2: Fetch subtitles
      let proxiedSubtitleUrl = null;
      try {
        const subRes = await fetch(`/api/media/subtitles?tmdbId=${tmdbId}&type=${type}&language=English&season=${season}&episode=${episode}`);
        if (subRes.ok) {
          const subData = await subRes.json();
          proxiedSubtitleUrl = subData.url;
        }
      } catch (err) {
        console.warn('[PartyPlayer] Subtitles fetch non-fatal error:', err);
      }

      // Step 3: Attach video & subtitles locally
      await this.attachStream(streamUrl, proxiedSubtitleUrl);

      // Step 4: Broadcast WebSocket party state
      const ntpNow = this.getNtpNow();
      this.currentVideo = {
        url: streamUrl,
        title: title,
        poster: movie.poster || '',
        provider: provider,
        subtitlesUrl: proxiedSubtitleUrl,
        tmdbId: tmdbId,
        type: type
      };

      this.syncState = {
        status: 'PAUS',
        position: 0,
        time: ntpNow,
        started: null,
        paused: 0,
        rate: 1.0
      };

      this.wsSend({
        type: 'party',
        party: {
          video: this.currentVideo,
          sync: {
            status: 'PAUS',
            position: 0,
            time: ntpNow,
            started: null,
            paused: 0
          }
        }
      });

      this.hideLoading();

      // Countdown and play
      await this.showCountdown(3);

      // Transition to play
      const playNtp = this.getNtpNow();
      this.syncState.status = 'PLAY';
      this.syncState.started = playNtp;
      this.syncState.paused = null;

      this.wsSend({
        type: 'party',
        party: {
          sync: {
            status: 'PLAY',
            position: 0,
            time: playNtp,
            started: playNtp,
            paused: null
          }
        }
      });

      try {
        await this.video.play();
      } catch {}

    } catch (err) {
      this.hideLoading();
      alert(`Could not load stream: ${err.message}`);
      throw err;
    }
  }

  /**
   * Attach stream URL to video element with Hls.js support
   * @param {string} url 
   * @param {string|null} [subtitlesUrl]
   */
  async attachStream(url, subtitlesUrl = null) {
    this.isHlsManifestLoaded = false;

    // Reset subtitles
    if (this.trackEl) {
      this.trackEl.remove();
      this.trackEl = null;
    }

    if (subtitlesUrl) {
      this.trackEl = document.createElement('track');
      this.trackEl.kind = 'subtitles';
      this.trackEl.label = 'English';
      this.trackEl.srclang = 'en';
      this.trackEl.src = subtitlesUrl;
      this.trackEl.default = true;
      this.video.appendChild(this.trackEl);
    }

    // Crucial rule: preservePitch must be set before playback rate changes
    this.video.preservesPitch = true;
    if ('mozPreservesPitch' in this.video) this.video.mozPreservesPitch = true;
    if ('webkitPreservesPitch' in this.video) this.video.webkitPreservesPitch = true;

    return new Promise((resolve, reject) => {
      const isM3u8 = url.includes('.m3u8');

      if (isM3u8 && window.Hls && window.Hls.isSupported()) {
        if (this.hls) {
          this.hls.destroy();
          this.hls = null;
        }

        this.hls = new window.Hls({
          enableWorker: true,
          lowLatencyMode: true,
        });

        this.hls.loadSource(url);
        this.hls.attachMedia(this.video);

        // Crucial requirement: manifestLoaded fires BEFORE drift loop starts
        this.hls.on(window.Hls.Events.MANIFEST_LOADED, () => {
          this.isHlsManifestLoaded = true;
          // Set playback rate AFTER Hls attaches
          this.video.playbackRate = 1.0;
          this.initDriftLoop();
          resolve();
        });

        this.hls.on(window.Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            console.error('[PartyPlayer] Fatal HLS error:', data);
            switch (data.type) {
              case window.Hls.ErrorTypes.NETWORK_ERROR:
                this.hls.startLoad();
                break;
              case window.Hls.ErrorTypes.MEDIA_ERROR:
                this.hls.recoverMediaError();
                break;
              default:
                this.hls.destroy();
                break;
            }
          }
        });

      } else {
        // Native playback (Safari HLS or MP4)
        this.video.src = url;
        this.video.playbackRate = 1.0;

        const onLoaded = () => {
          this.video.removeEventListener('loadedmetadata', onLoaded);
          this.isHlsManifestLoaded = true;
          this.initDriftLoop();
          resolve();
        };

        this.video.addEventListener('loadedmetadata', onLoaded);
        this.video.load();
      }
    });
  }

  /**
   * Handle remote video / sync change from WebSocket
   * @param {Object} partyState 
   */
  async handleRemoteVideoChange(partyState) {
    if (!partyState) return;

    const newVideo = partyState.video;
    const newSync = partyState.sync;

    // 1. If video URL changed or is new, load stream
    if (newVideo && (!this.currentVideo || this.currentVideo.url !== newVideo.url)) {
      this.currentVideo = newVideo;
      await this.attachStream(newVideo.url, newVideo.subtitlesUrl);
    }

    // 2. If sync state arrived, update desired position
    if (newSync) {
      this.applySync(newSync);

      const desiredMs = this.getDesiredPositionMs();
      const currentMs = Math.round(this.video.currentTime * 1000);
      const diffMs = Math.abs(desiredMs - currentMs);

      // Prevent local event emission while applying remote seek
      if (diffMs > 150) {
        this.isRemoteSync.current = true;
        this.video.currentTime = desiredMs / 1000;
        setTimeout(() => {
          this.isRemoteSync.current = false;
        }, 200);
      }

      // Align play/pause state
      const isPaused = this.isPaused();
      if (isPaused && !this.video.paused) {
        this.isRemoteSync.current = true;
        this.video.pause();
        setTimeout(() => { this.isRemoteSync.current = false; }, 200);
      } else if (!isPaused && this.video.paused) {
        this.isRemoteSync.current = true;
        this.video.play().catch(() => {}).finally(() => {
          setTimeout(() => { this.isRemoteSync.current = false; }, 200);
        });
      }
    }
  }

  applySync(sync) {
    if (!sync) return;
    if (sync.status !== undefined) this.syncState.status = sync.status;
    if (sync.position !== undefined) this.syncState.position = sync.position;
    if (sync.time !== undefined) this.syncState.time = sync.time;
    if (sync.started !== undefined) this.syncState.started = sync.started;
    if (sync.paused !== undefined) this.syncState.paused = sync.paused;
    if (sync.rate !== undefined) this.syncState.rate = sync.rate;
  }

  isPaused() {
    if (this.syncState.status === 'PAUS') return true;
    if (this.syncState.paused !== null && this.syncState.paused !== undefined) return true;
    return false;
  }

  getDesiredPositionMs() {
    const ntpNow = this.getNtpNow();

    // Check Hearo/StreamSync protocol status format
    if (this.syncState.status === 'PAUS') {
      return this.syncState.position || 0;
    }

    if (this.syncState.status === 'PLAY') {
      const elapsed = Math.max(0, ntpNow - (this.syncState.time || ntpNow));
      return (this.syncState.position || 0) + elapsed;
    }

    // Check VirtualTimeline format fallback
    if (this.syncState.paused !== null && this.syncState.paused !== undefined) {
      return this.syncState.paused;
    }

    if (this.syncState.started !== null && this.syncState.started !== undefined) {
      return Math.max(0, (ntpNow - this.syncState.started) * (this.syncState.rate || 1.0));
    }

    return 0;
  }

  /**
   * Continuous drift correction loop
   * Runs every 500ms on requestAnimationFrame with timestamp guard
   */
  initDriftLoop() {
    if (this.isDriftRunning) return;
    this.isDriftRunning = true;

    const loop = (timestamp) => {
      if (!this.isDriftRunning) return;

      if (!this.lastDriftCheck || timestamp - this.lastDriftCheck >= 500) {
        this.lastDriftCheck = timestamp;
        this._checkDrift();
      }

      this.driftRafId = requestAnimationFrame(loop);
    };

    this.driftRafId = requestAnimationFrame(loop);
  }

  stopDriftLoop() {
    this.isDriftRunning = false;
    if (this.driftRafId) {
      cancelAnimationFrame(this.driftRafId);
      this.driftRafId = null;
    }
  }

  _checkDrift() {
    if (!this.isHlsManifestLoaded || this.isRemoteSync.current) return;

    const currentMs = Math.round(this.video.currentTime * 1000);
    const targetMs = Math.round(this.getDesiredPositionMs());
    const isPaused = this.isPaused();

    const action = getDriftAction(currentMs, targetMs, isPaused);

    if (action.type === 'seek') {
      this.isRemoteSync.current = true;
      this.video.currentTime = action.targetSec;
      this.video.playbackRate = 1.0;
      setTimeout(() => {
        this.isRemoteSync.current = false;
      }, 250);
    } else if (action.type === 'rate') {
      // Ensure preservesPitch is set before adjusting rate
      this.video.preservesPitch = true;
      if (this.video.playbackRate !== action.rate) {
        this.video.playbackRate = action.rate;
      }
    }
  }

  _bindVideoEvents() {
    // onPlay
    this.video.addEventListener('play', () => {
      if (this.isRemoteSync.current) return;
      const ntpNow = this.getNtpNow();
      const currentMs = Math.round(this.video.currentTime * 1000);

      this.syncState.status = 'PLAY';
      this.syncState.position = currentMs;
      this.syncState.time = ntpNow;
      this.syncState.started = ntpNow - currentMs;
      this.syncState.paused = null;

      this.wsSend({
        type: 'party',
        party: {
          sync: {
            status: 'PLAY',
            position: currentMs,
            time: ntpNow,
            started: this.syncState.started,
            paused: null
          }
        }
      });
    });

    // onPause
    this.video.addEventListener('pause', () => {
      if (this.isRemoteSync.current) return;
      const ntpNow = this.getNtpNow();
      const currentMs = Math.round(this.video.currentTime * 1000);

      this.syncState.status = 'PAUS';
      this.syncState.position = currentMs;
      this.syncState.time = ntpNow;
      this.syncState.paused = currentMs;

      this.wsSend({
        type: 'party',
        party: {
          sync: {
            status: 'PAUS',
            position: currentMs,
            time: ntpNow,
            paused: currentMs
          }
        }
      });
    });

    // onSeeked
    this.video.addEventListener('seeked', () => {
      if (this.isRemoteSync.current) return;
      const ntpNow = this.getNtpNow();
      const currentMs = Math.round(this.video.currentTime * 1000);
      const isPaused = this.video.paused;

      if (isPaused) {
        this.syncState.status = 'PAUS';
        this.syncState.position = currentMs;
        this.syncState.time = ntpNow;
        this.syncState.paused = currentMs;

        this.wsSend({
          type: 'party',
          party: {
            sync: {
              status: 'PAUS',
              position: currentMs,
              time: ntpNow,
              paused: currentMs
            }
          }
        });
      } else {
        this.syncState.status = 'PLAY';
        this.syncState.position = currentMs;
        this.syncState.time = ntpNow;
        this.syncState.started = ntpNow - currentMs;
        this.syncState.paused = null;

        this.wsSend({
          type: 'party',
          party: {
            sync: {
              status: 'PLAY',
              position: currentMs,
              time: ntpNow,
              started: this.syncState.started,
              paused: null
            }
          }
        });
      }
    });
  }

  destroy() {
    this.stopDriftLoop();
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    if (this.loadingOverlay) this.loadingOverlay.remove();
    if (this.countdownOverlay) this.countdownOverlay.remove();
  }
}

export default PartyPlayer;

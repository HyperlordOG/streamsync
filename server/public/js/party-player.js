/**
 * StreamSync - Party Player Client Module (Streamo Feature-Parity Edition)
 * 
 * Features:
 * - 4 Player Themes: Streamo (Default), Netflix (Red & 10s skip icons), Prime Video (Cyan), Cinema (Gold)
 * - Custom Controls Overlay with auto-hide, scrubber progress bar, and hover tooltip
 * - Skip -10s and Skip +10s buttons with party synchronization
 * - Streamo-Style Glassmorphic Settings Modal with Playback and Subtitles tabs
 * - Playback Speed (0.5x, 0.75x, 1.0x, 1.25x, 1.5x, 2.0x)
 * - Brightness Filter (80%, 100%, 120%, 140%)
 * - Web Audio API Speech Clarity & Volume Booster (100% to 300%)
 * - Fill Screen / Aspect Ratio toggle (fit vs cover)
 * - Febbox VIP 1080p/4K Cookie Manager & Validator
 * - Hls.js master manifest resolution & dual-threshold drift correction
 */

export function getDriftAction(currentMs, targetMs, isPaused = false) {
  // Root cause B fix: round both currentMs and targetMs to nearest 100ms
  // Eliminates sub-100ms false positives between iOS Safari (centisecond) and Android Chrome (microsecond)
  const roundedCurrent = Math.round(currentMs / 100) * 100;
  const roundedTarget = Math.round(targetMs / 100) * 100;
  const deltaMs = roundedTarget - roundedCurrent;
  const absDeltaMs = Math.abs(deltaMs);

  if (absDeltaMs >= 2000) {
    return { type: 'seek', targetMs, targetSec: targetMs / 1000, deltaMs, zone: 'ZONE 3 [Hard Seek]' };
  } else if (absDeltaMs >= 400 && !isPaused) {
    const rate = deltaMs > 0 ? 1.05 : 0.95;
    return { type: 'rate', rate, deltaMs, zone: deltaMs > 0 ? 'ZONE 1 [Slew Fast +5%]' : 'ZONE 1 [Slew Slow -5%]' };
  }
  return { type: 'rate', rate: 1.0, deltaMs, zone: 'ZONE 0 [In Sync]' };
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Web Audio API Speech Clarity & Volume Boost Engine
 */
export class AudioEnhancer {
  constructor(videoEl) {
    this.video = videoEl;
    this.ctx = null;
    this.source = null;
    this.gainNode = null;
    this.compressor = null;
    this.clarityFilter = null;
    this.isInitialized = false;
    this.boostLevel = 1.5; // Default 150% Clear Speech
  }

  init() {
    if (this.isInitialized) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();

      // Dialogue intelligibility peaking filter (@ 2.8kHz boosts consonants & human voice clarity)
      this.clarityFilter = this.ctx.createBiquadFilter();
      this.clarityFilter.type = 'peaking';
      this.clarityFilter.frequency.value = 2800;
      this.clarityFilter.Q.value = 1.2;
      this.clarityFilter.gain.value = 4.5; // +4.5dB speech lift

      // Dynamics Compressor (lifts whisper-quiet dialogue, tames harsh explosions)
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.setValueAtTime(-24, this.ctx.currentTime);
      this.compressor.knee.setValueAtTime(30, this.ctx.currentTime);
      this.compressor.ratio.setValueAtTime(12, this.ctx.currentTime);
      this.compressor.attack.setValueAtTime(0.003, this.ctx.currentTime);
      this.compressor.release.setValueAtTime(0.25, this.ctx.currentTime);

      // Volume Gain Node (100% to 300% boost)
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.setValueAtTime(this.boostLevel, this.ctx.currentTime);

      // Hook video element to Web Audio graph
      this.source = this.ctx.createMediaElementSource(this.video);
      this.source.connect(this.clarityFilter);
      this.clarityFilter.connect(this.compressor);
      this.compressor.connect(this.gainNode);
      this.gainNode.connect(this.ctx.destination);

      this.isInitialized = true;
    } catch (err) {
      console.warn('[AudioEnhancer] Web Audio API init warning:', err);
    }
  }

  setBoost(level) {
    this.boostLevel = Number(level) || 1.0;
    if (!this.isInitialized) {
      this.init();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    if (this.gainNode && this.ctx) {
      this.gainNode.gain.setTargetAtTime(this.boostLevel, this.ctx.currentTime, 0.05);
    }
  }
}

export class PartyPlayer {
  constructor(videoEl, options = {}) {
    this.video = typeof videoEl === 'string' ? document.querySelector(videoEl) : videoEl;
    if (!this.video) {
      throw new Error('PartyPlayer requires a valid video element');
    }

    this.wsSend = options.wsSend || (() => {});
    this.getNtpNow = options.getNtpNow || (() => Date.now());
    this.container = options.container || this.video.parentElement || document.body;

    // REF guard to prevent echo loops during remote sync
    this.isRemoteSync = { current: false };
    this.ignoreEventsUntil = 0;

    // Internal HLS instance
    this.hls = null;
    this.isHlsManifestLoaded = false;

    this.isDebugMode = typeof window !== 'undefined' && window.location && new URLSearchParams(window.location.search).get('debug') === '1';

    // Timeline sync state
    this.syncState = {
      status: 'PAUS',
      position: 0,
      time: 0,
      started: null,
      paused: 0,
      rate: 1.0,
    };

    // Current loaded video metadata
    this.currentVideo = null;
    this.availableProviders = [];
    this.availableQualities = [];
    this.currentQuality = '1080p';
    this.currentProvider = 'Edge';

    // Player customization settings
    const storedTheme = typeof localStorage !== 'undefined' ? localStorage.getItem('streamo:player-theme') : null;
    this.theme = storedTheme || 'streamo';
    this.playbackSpeed = 1.0;
    this.brightness = 100;
    this.isFillScreen = false;
    const storedCookie = typeof localStorage !== 'undefined' ? localStorage.getItem('streamo:febbox-cookies') : null;
    this.febboxCookie = storedCookie || '';

    // Drift loop control
    this.driftRafId = null;
    this.lastDriftCheck = 0;
    this.isDriftRunning = false;

    // Subtitle tracks
    this.trackEl = null;
    this.subtitleTracks = [];
    this.activeSubtitleUrl = null;

    // Audio Enhancer
    this.audioEnhancer = new AudioEnhancer(this.video);

    // Inactivity timer for auto-hiding controls
    this.controlsTimeout = null;

    // Inject styles and build custom UI
    this._injectStyles();
    this._createOverlays();
    this._createCustomControls();
    this._createEpisodesDrawer();
    this._createSettingsMenu();
    this._createFebboxModal();
    this.setTheme(this.theme);
    this.initCasting();

    // Attach local video event listeners
    this._bindVideoEvents();

    // Auto-init audio on user first click anywhere on video
    this.video.addEventListener('click', () => {
      this.audioEnhancer.setBoost(this.audioEnhancer.boostLevel);
    }, { once: true });
  }

  _injectStyles() {
    if (document.getElementById('party-player-styles')) return;
    const style = document.createElement('style');
    style.id = 'party-player-styles';
    style.textContent = `
      /* Theme variables */
      .theme-streamo {
        --player-accent: #6366f1;
        --player-accent-hover: #4f46e5;
        --player-glow: rgba(99, 102, 241, 0.45);
        --player-progress: #818cf8;
      }
      .theme-netflix {
        --player-accent: #e50914;
        --player-accent-hover: #b80710;
        --player-glow: rgba(229, 9, 20, 0.5);
        --player-progress: #e50914;
      }
      .theme-prime {
        --player-accent: #00a8e1;
        --player-accent-hover: #0093c7;
        --player-glow: rgba(0, 168, 225, 0.45);
        --player-progress: #00a8e1;
      }
      .theme-cinema {
        --player-accent: #f59e0b;
        --player-accent-hover: #d97706;
        --player-glow: rgba(245, 158, 11, 0.45);
        --player-progress: #fbbf24;
      }

      .video-wrapper {
        position: relative;
        overflow: hidden;
        user-select: none;
      }

      /* Custom Player Controls Bar */
      .stream-controls-overlay {
        position: absolute;
        inset: 0;
        pointer-events: none;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        z-index: 10 !important;
        opacity: 0;
        transition: opacity 0.25s ease;
      }
      .video-wrapper:hover .stream-controls-overlay,
      .stream-controls-overlay.active,
      .video-wrapper.is-paused .stream-controls-overlay {
        opacity: 1;
      }

      .stream-controls-top {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        padding: 14px 18px;
        pointer-events: auto;
      }

      .stream-controls-bar {
        background: linear-gradient(to top, rgba(0, 0, 0, 0.95) 0%, rgba(0, 0, 0, 0.6) 70%, transparent 100%);
        padding: 14px 20px 16px;
        pointer-events: auto;
      }

      /* Progress Bar */
      .stream-progress-wrap {
        position: relative;
        height: 6px;
        background: rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        cursor: pointer;
        margin-bottom: 12px;
        transition: height 0.15s ease;
      }
      .stream-progress-wrap:hover {
        height: 10px;
      }
      .stream-progress-buffer {
        position: absolute;
        top: 0;
        left: 0;
        bottom: 0;
        width: 0%;
        background: rgba(255, 255, 255, 0.4);
        border-radius: 4px;
      }
      .stream-progress-played {
        position: absolute;
        top: 0;
        left: 0;
        bottom: 0;
        width: 0%;
        background: var(--player-progress, #818cf8);
        border-radius: 4px;
        box-shadow: 0 0 10px var(--player-glow, rgba(99, 102, 241, 0.5));
      }
      .stream-progress-thumb {
        position: absolute;
        top: 50%;
        right: -6px;
        transform: translateY(-50%) scale(0);
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 2px 6px rgba(0,0,0,0.6);
        transition: transform 0.15s ease;
      }
      .stream-progress-wrap:hover .stream-progress-thumb {
        transform: translateY(-50%) scale(1);
      }
      .stream-progress-tooltip {
        position: absolute;
        bottom: 18px;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.85);
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        padding: 3px 6px;
        border-radius: 4px;
        pointer-events: none;
        display: none;
        white-space: nowrap;
      }

      /* Control Buttons Row */
      .stream-buttons-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .stream-btn-group {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .stream-ctrl-btn,
      .touch-target {
        background: transparent;
        border: none;
        color: #f1f5f9;
        cursor: pointer;
        padding: 6px;
        border-radius: 8px;
        min-width: 44px !important;
        min-height: 44px !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        transition: all 0.15s ease;
        position: relative;
        touch-action: manipulation;
      }
      .stream-ctrl-btn:hover {
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
        transform: scale(1.08);
      }
      .stream-skip-btn {
        font-weight: 800;
        font-size: 13px;
        gap: 3px;
      }
      .stream-time-text {
        font-size: 13px;
        font-weight: 600;
        color: #cbd5e1;
        margin-left: 6px;
        font-variant-numeric: tabular-nums;
      }

      /* Volume Slider */
      .stream-vol-wrap {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .stream-vol-slider {
        width: 0;
        opacity: 0;
        transition: width 0.2s ease, opacity 0.2s ease;
        cursor: pointer;
        accent-color: var(--player-accent, #6366f1);
      }
      .stream-vol-wrap:hover .stream-vol-slider {
        width: 70px;
        opacity: 1;
      }

      /* Center Ripple Feedback */
      .stream-center-feedback {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%) scale(0.6);
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(12px);
        width: 80px;
        height: 80px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        opacity: 0;
        pointer-events: none;
        transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        z-index: 38;
      }
      .stream-center-feedback.show {
        opacity: 1;
        transform: translate(-50%, -50%) scale(1);
      }

      /* Streamo Settings Popover Menu */
      .streamo-settings-menu {
        position: absolute;
        bottom: 74px;
        right: 18px;
        width: 320px;
        background: rgba(15, 23, 42, 0.96);
        backdrop-filter: blur(24px);
        -webkit-backdrop-filter: blur(24px);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 16px;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.85);
        color: #f8fafc;
        z-index: 400 !important;
        display: none;
        flex-direction: column;
        overflow: hidden;
        animation: menuFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      @keyframes menuFadeIn {
        from { opacity: 0; transform: translateY(10px) scale(0.97); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      .settings-tabs {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(0, 0, 0, 0.3);
      }
      .settings-tab-btn {
        padding: 12px;
        background: transparent;
        border: none;
        color: #94a3b8;
        font-weight: 700;
        font-size: 13px;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .settings-tab-btn.active {
        color: #fff;
        background: var(--player-accent, #6366f1);
      }

      .settings-content-pane {
        padding: 16px;
        max-height: 380px;
        overflow-y: auto;
      }

      /* 2x2 Quick Cards */
      .settings-grid-cards {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 8px;
        margin-bottom: 14px;
      }
      .settings-stat-card {
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 10px;
        padding: 10px;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .settings-stat-card:hover {
        background: rgba(255, 255, 255, 0.12);
        border-color: var(--player-accent, #6366f1);
      }
      .settings-card-label {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #94a3b8;
        font-weight: 700;
        margin-bottom: 4px;
      }
      .settings-card-val {
        font-size: 13px;
        font-weight: 700;
        color: #fff;
      }

      /* Settings Row List */
      .settings-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 8px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        color: #e2e8f0;
        transition: background 0.15s ease;
      }
      .settings-row:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      .settings-row-val {
        color: #94a3b8;
        font-size: 12px;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      /* Submenu List View */
      .settings-submenu-view {
        display: none;
      }
      .settings-submenu-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding-bottom: 12px;
        margin-bottom: 8px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
        color: #94a3b8;
      }
      .settings-submenu-header:hover {
        color: #fff;
      }
      .settings-option-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 9px 10px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 13px;
        transition: all 0.15s ease;
      }
      .settings-option-item:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      .settings-option-item.selected {
        background: rgba(99, 102, 241, 0.15);
        color: var(--player-accent, #6366f1);
        font-weight: 700;
      }

      /* Febbox Modal */
      .febbox-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.8);
        backdrop-filter: blur(12px);
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 500 !important;
        padding: 20px;
      }
      .febbox-modal-card {
        background: #0f172a;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 20px;
        width: 100%;
        max-width: 520px;
        box-shadow: 0 25px 60px rgba(0, 0, 0, 0.9);
        overflow: hidden;
      }
      .febbox-modal-header {
        padding: 20px 24px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .febbox-modal-body {
        padding: 24px;
      }
      .febbox-callout {
        background: rgba(245, 158, 11, 0.1);
        border: 1px solid rgba(245, 158, 11, 0.25);
        border-radius: 12px;
        padding: 14px;
        font-size: 13px;
        line-height: 1.5;
        color: #fef3c7;
        margin-bottom: 20px;
      }
      .febbox-input {
        width: 100%;
        background: rgba(0, 0, 0, 0.5);
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 10px;
        padding: 12px 14px;
        color: #fff;
        font-size: 13px;
        font-family: monospace;
        margin-bottom: 12px;
      }
      .febbox-input:focus {
        border-color: var(--player-accent, #6366f1);
        outline: none;
      }

      /* Toggle switch */
      .stream-switch {
        position: relative;
        display: inline-block;
        width: 38px;
        height: 20px;
      }
      .stream-switch input { opacity: 0; width: 0; height: 0; }
      .stream-slider {
        position: absolute;
        inset: 0;
        background: #334155;
        border-radius: 20px;
        transition: 0.2s;
        cursor: pointer;
      }
      .stream-slider:before {
        position: absolute;
        content: "";
        height: 14px;
        width: 14px;
        left: 3px;
        bottom: 3px;
        background-color: white;
        border-radius: 50%;
        transition: 0.2s;
      }
      .stream-switch input:checked + .stream-slider {
        background-color: var(--player-accent, #6366f1);
      }
      .stream-switch input:checked + .stream-slider:before {
        transform: translateX(18px);
      }

      /* In-Player Episode Drawer */
      .stream-episodes-drawer {
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        width: 380px;
        max-width: 90vw;
        background: rgba(13, 17, 23, 0.95);
        backdrop-filter: blur(20px);
        border-left: 1px solid rgba(255, 255, 255, 0.12);
        z-index: 50;
        transform: translateX(100%);
        transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        display: flex;
        flex-direction: column;
        box-shadow: -10px 0 30px rgba(0, 0, 0, 0.8);
      }
      .stream-episodes-drawer.open {
        transform: translateX(0);
      }
      .stream-ep-drawer-header {
        padding: 16px 20px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .stream-ep-drawer-title {
        font-size: 15px;
        font-weight: 700;
        color: #fff;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .stream-ep-drawer-close {
        background: none;
        border: none;
        color: #94a3b8;
        font-size: 18px;
        cursor: pointer;
        padding: 4px;
      }
      .stream-ep-drawer-close:hover {
        color: #fff;
      }
      .stream-ep-season-select-wrap {
        padding: 12px 16px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.02);
      }
      .stream-ep-season-dropdown {
        width: 100%;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 8px;
        color: #fff;
        font-size: 13px;
        font-weight: 600;
        padding: 8px 12px;
        outline: none;
      }
      .stream-ep-season-dropdown option {
        background: #0f172a;
        color: #fff;
      }
      .stream-ep-list {
        flex: 1;
        overflow-y: auto;
        padding: 12px 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .stream-ep-list::-webkit-scrollbar {
        width: 4px;
      }
      .stream-ep-list::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.15);
        border-radius: 2px;
      }
      .stream-ep-item {
        display: flex;
        gap: 12px;
        padding: 10px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 10px;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .stream-ep-item:hover {
        background: rgba(255, 255, 255, 0.08);
        border-color: var(--player-accent, #6366f1);
      }
      .stream-ep-item.active {
        background: rgba(99, 102, 241, 0.2);
        border-color: var(--player-accent, #6366f1);
      }
      .stream-ep-item-thumb {
        width: 80px;
        aspect-ratio: 16/9;
        border-radius: 6px;
        object-fit: cover;
        background: #1e293b;
        flex-shrink: 0;
      }
      .stream-ep-item-info {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 2px;
        flex: 1;
        min-width: 0;
      }
      .stream-ep-item-num {
        font-size: 10px;
        font-weight: 700;
        color: var(--player-accent, #818cf8);
        text-transform: uppercase;
      }
      .stream-ep-item-title {
        font-size: 12px;
        font-weight: 600;
        color: #f1f5f9;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .stream-ep-item-duration {
        font-size: 11px;
        color: #94a3b8;
      }

      /* Subtitles styling */
      video::cue {
        background: rgba(0, 0, 0, 0.8) !important;
        color: #f8fafc !important;
        font-family: 'Inter', -apple-system, sans-serif !important;
        font-weight: 600 !important;
        font-size: 1.25rem !important;
        line-height: 1.4 !important;
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.95) !important;
        padding: 4px 10px !important;
        border-radius: 6px !important;
      }

      /* Phase 4: Smart TV Remote Mode & Cast Styling */
      .stream-ctrl-btn#btn-player-cast.is-active {
        color: #60a5fa;
        filter: drop-shadow(0 0 8px rgba(96, 165, 250, 0.8));
      }
      .video-wrapper.is-remote-mode .video-element {
        opacity: 0.15;
        filter: blur(8px);
      }
      .video-wrapper.is-remote-mode::after {
        content: '📺 Playing on Smart TV / AirPlay • Phone is Synchronized Remote';
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(15, 23, 42, 0.88);
        border: 1px solid rgba(96, 165, 250, 0.4);
        padding: 12px 20px;
        border-radius: 12px;
        font-weight: 700;
        font-size: 14px;
        color: #93c5fd;
        pointer-events: none;
        z-index: 25;
        box-shadow: 0 10px 30px rgba(0,0,0,0.7);
        text-align: center;
      }

      /* Video element & Controls Z-Index Layering */
      #media-player, video {
        z-index: 1 !important;
      }
      .stream-controls-overlay,
      .stream-controls-bar {
        z-index: 10 !important;
      }

      /* Stream Loading & Countdown Overlays */
      .stream-overlay-backdrop {
        position: absolute !important;
        inset: 0 !important;
        top: 0 !important;
        left: 0 !important;
        width: 100% !important;
        height: 100% !important;
        background: rgba(9, 13, 22, 0.94) !important;
        backdrop-filter: blur(14px) !important;
        -webkit-backdrop-filter: blur(14px) !important;
        display: none !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        padding: 24px !important;
        text-align: center !important;
        z-index: 50 !important;
        box-sizing: border-box !important;
        pointer-events: auto !important;
      }
      .stream-overlay-backdrop.active {
        display: flex !important;
      }
      #party-countdown-overlay,
      .stream-countdown-overlay {
        z-index: 51 !important;
      }
      .stream-overlay-title {
        font-family: 'Outfit', -apple-system, sans-serif !important;
        font-size: clamp(14px, 2.8vw, 20px) !important;
        font-weight: 700 !important;
        color: #fff !important;
        margin-top: 14px !important;
        margin-bottom: 6px !important;
        max-width: 90% !important;
        line-height: 1.35 !important;
        text-align: center !important;
        word-break: break-word !important;
        overflow-wrap: break-word !important;
      }
      .stream-overlay-sub {
        font-size: clamp(11px, 2vw, 13px) !important;
        color: #94a3b8 !important;
        max-width: 88% !important;
        line-height: 1.4 !important;
        text-align: center !important;
        word-break: break-word !important;
        overflow-wrap: break-word !important;
      }
      .stream-loading-spinner {
        width: 36px !important;
        height: 36px !important;
        border: 3px solid rgba(99, 102, 241, 0.2) !important;
        border-top-color: #818cf8 !important;
        border-radius: 50% !important;
        animation: streamSpin 0.8s linear infinite !important;
      }
      @keyframes streamSpin {
        to { transform: rotate(360deg); }
      }
      .stream-countdown {
        font-family: 'Outfit', sans-serif !important;
        font-size: 64px !important;
        font-weight: 800 !important;
        color: #818cf8 !important;
        text-shadow: 0 0 30px rgba(99, 102, 241, 0.6) !important;
      }

      /* Mobile Autoplay Fallback Prompt */
      .party-play-prompt {
        position: absolute !important;
        inset: 0 !important;
        display: none !important;
        align-items: center !important;
        justify-content: center !important;
        background: rgba(9, 13, 22, 0.8) !important;
        backdrop-filter: blur(8px) !important;
        -webkit-backdrop-filter: blur(8px) !important;
        z-index: 52 !important;
        cursor: pointer !important;
      }
      .party-play-prompt.active {
        display: flex !important;
      }
      /* Fix 5: Player Lock Screen Feature */
      .video-wrapper.player-locked .video-controls,
      .video-wrapper.player-locked .stream-controls-overlay,
      .video-wrapper.player-locked .stream-controls-bar,
      .video-wrapper.player-locked .sync-hud,
      .video-wrapper.player-locked .stream-overlay-backdrop:not(.player-lock-overlay) {
        pointer-events: none !important;
        opacity: 0 !important;
      }

      .player-lock-overlay {
        position: absolute !important;
        inset: 0 !important;
        z-index: 100 !important;
        display: none !important;
        align-items: center !important;
        justify-content: center !important;
        background: transparent !important;
        touch-action: none !important; /* iOS swipe-back prevent */
        user-select: none !important;  /* Android selection popup prevent */
        -webkit-user-select: none !important;
      }

      .video-wrapper.player-locked .player-lock-overlay {
        display: flex !important;
        pointer-events: all !important;
      }

      .unlock-hint {
        color: rgba(255, 255, 255, 0.7);
        font-size: clamp(12px, 3vw, 16px);
        padding: 8px 16px;
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 20px;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.2s ease, background 0.2s ease, color 0.2s ease;
        user-select: none;
        -webkit-user-select: none;
        touch-action: manipulation;
      }

      .unlock-hint:active {
        transform: scale(0.95);
        background: rgba(0, 0, 0, 0.75);
        color: #fff;
      }

      .stream-lock-btn {
        background: transparent;
        border: none;
        color: #f1f5f9;
        cursor: pointer;
        border-radius: 8px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        touch-action: manipulation;
      }

      .stream-lock-icon, .stream-lock-icon-bottom {
        display: inline-block;
        transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      }

      .stream-lock-icon.anim-scale, .stream-lock-icon-bottom.anim-scale {
        animation: lockToggleScale 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      }

      @keyframes lockToggleScale {
        0% { transform: scale(0.6); }
        50% { transform: scale(1.35); }
        100% { transform: scale(1); }
      }
      .party-play-prompt-card {
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        padding: 20px 24px !important;
        background: rgba(30, 41, 59, 0.95) !important;
        border: 1px solid rgba(99, 102, 241, 0.5) !important;
        border-radius: 16px !important;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6), 0 0 20px rgba(99, 102, 241, 0.3) !important;
        animation: promptPulse 1.8s infinite ease-in-out !important;
      }
      @keyframes promptPulse {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.04); }
      }
      .party-play-prompt-btn {
        width: 56px !important;
        height: 56px !important;
        border-radius: 50% !important;
        background: linear-gradient(135deg, #6366f1, #8b5cf6) !important;
        color: #fff !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        margin-bottom: 12px !important;
        box-shadow: 0 4px 16px rgba(99, 102, 241, 0.5) !important;
      }
      .party-play-prompt-text {
        font-family: 'Outfit', -apple-system, sans-serif !important;
        font-size: 16px !important;
        font-weight: 700 !important;
        color: #fff !important;
        margin-bottom: 4px !important;
      }
      .party-play-prompt-sub {
        font-size: 12px !important;
        color: #94a3b8 !important;
      }

      /* Settings Modal Backdrop & Bottom Sheet */
      .streamo-settings-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.65);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        z-index: 401 !important;
        display: none;
      }

      .mobile-sheet-handle-bar {
        display: none;
        align-items: center;
        justify-content: space-between;
        padding: 10px 16px 6px;
        background: rgba(15, 23, 42, 0.98);
      }
      .mobile-sheet-handle {
        width: 38px;
        height: 4px;
        background: rgba(255, 255, 255, 0.25);
        border-radius: 9999px;
        margin: 0 auto;
      }
      .mobile-sheet-close-btn {
        background: transparent;
        border: none;
        color: #94a3b8;
        font-size: 20px;
        cursor: pointer;
        padding: 4px 8px;
        line-height: 1;
      }

      /* Momentum Touch Scrolling for All Panels */
      .scrollable-panel,
      .stream-ep-list,
      .settings-content-pane,
      .streamo-settings-menu {
        overflow-y: auto !important;
        -webkit-overflow-scrolling: touch !important;
        overscroll-behavior: contain !important;
        scroll-behavior: smooth !important;
        touch-action: pan-y !important;
      }

      /* Universal Fullscreen Fallback */
      .video-wrapper.is-pseudo-fullscreen {
        position: fixed !important;
        inset: 0 !important;
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important;
        height: 100dvh !important;
        height: calc(var(--vh, 1vh) * 100) !important;
        max-width: 100vw !important;
        max-height: 100dvh !important;
        max-height: calc(var(--vh, 1vh) * 100) !important;
        z-index: 9999 !important;
        border-radius: 0 !important;
        background: #000 !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      body.has-pseudo-fullscreen {
        overflow: hidden !important;
      }

      /* Mobile Controls & Video Responsiveness */
      @media (max-width: 640px) {
        .stream-controls-bar {
          padding: 8px 10px 10px !important;
        }
        .stream-progress-wrap {
          margin-bottom: 8px !important;
          height: 5px !important;
        }
        .stream-buttons-row {
          gap: 4px !important;
        }
        .stream-btn-group {
          gap: 4px !important;
        }
        .stream-ctrl-btn {
          padding: 4px !important;
        }
        .stream-ctrl-btn svg {
          width: 18px !important;
          height: 18px !important;
        }
        .stream-skip-btn {
          font-size: 11px !important;
          gap: 1px !important;
        }
        .stream-time-text {
          font-size: 11px !important;
          margin-left: 2px !important;
          letter-spacing: -0.02em !important;
        }
        /* Mobile hardware buttons control volume, hide slider & mute on small screens */
        .stream-vol-wrap {
          display: none !important;
        }
        /* Hide PiP button to conserve space on mobile */
        #btn-player-pip {
          display: none !important;
        }
        #btn-player-quality-pill {
          padding: 3px 6px !important;
          font-size: 10px !important;
        }
        /* Settings popover as bottom sheet drawer on mobile */
        .mobile-sheet-handle-bar {
          display: flex !important;
        }
        .streamo-settings-menu {
          position: fixed !important;
          bottom: 0 !important;
          left: 0 !important;
          right: 0 !important;
          top: auto !important;
          width: 100vw !important;
          max-width: 100vw !important;
          max-height: 75vh !important;
          border-radius: 20px 20px 0 0 !important;
          z-index: 400 !important;
          box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.9) !important;
          border: 1px solid rgba(255, 255, 255, 0.15) !important;
          border-bottom: none !important;
          background: rgba(15, 23, 42, 0.98) !important;
          overflow: hidden !important;
        }
        .settings-content-pane {
          max-height: calc(75vh - 70px) !important;
          overflow-y: auto !important;
          -webkit-overflow-scrolling: touch !important;
          padding-bottom: 30px !important;
        }
        video::cue {
          font-size: 0.95rem !important;
          padding: 3px 6px !important;
          line-height: 1.25 !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  _createOverlays() {
    this.loadingOverlay = document.createElement('div');
    this.loadingOverlay.className = 'stream-overlay-backdrop';
    this.loadingOverlay.style.display = 'none';
    this.loadingOverlay.innerHTML = `
      <div class="stream-loading-spinner"></div>
      <div class="stream-overlay-title" id="party-loader-title">Finding best stream...</div>
      <div class="stream-overlay-sub" id="party-loader-sub">Negotiating token with Streamo CDN network</div>
    `;
    this.container.appendChild(this.loadingOverlay);

    this.countdownOverlay = document.createElement('div');
    this.countdownOverlay.id = 'party-countdown-overlay';
    this.countdownOverlay.className = 'stream-overlay-backdrop stream-countdown-overlay';
    this.countdownOverlay.style.display = 'none';
    this.countdownOverlay.innerHTML = `
      <div class="stream-overlay-sub" style="margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700;">Starting In</div>
      <div class="stream-countdown" id="party-countdown-num">3</div>
    `;
    this.container.appendChild(this.countdownOverlay);

    // Center Splash Feedback Icon
    this.centerSplash = document.createElement('div');
    this.centerSplash.className = 'stream-center-feedback';
    this.container.appendChild(this.centerSplash);
  }

  _createCustomControls() {
    // Remove native controls to show our Streamo UI
    this.video.controls = false;

    this.controlsOverlay = document.createElement('div');
    this.controlsOverlay.className = 'stream-controls-overlay';
    this.controlsOverlay.innerHTML = `
      <div class="stream-controls-top">
        <button class="stream-ctrl-btn stream-lock-btn touch-target" id="btn-player-lock" title="Lock Screen (L)">
          <span class="stream-lock-icon" id="stream-lock-icon">🔒</span>
        </button>
      </div>

      <div class="stream-controls-bar">
        <!-- Interactive Progress Scrubber -->
        <div class="stream-progress-wrap" id="stream-progress-bar">
          <div class="stream-progress-buffer" id="stream-progress-buffer"></div>
          <div class="stream-progress-played" id="stream-progress-played">
            <div class="stream-progress-thumb"></div>
          </div>
          <div class="stream-progress-tooltip" id="stream-progress-tooltip">00:00</div>
        </div>

        <!-- Buttons Row -->
        <div class="stream-buttons-row">
          <div class="stream-btn-group">
            <!-- Play / Pause -->
            <button class="stream-ctrl-btn" id="btn-player-play" title="Play/Pause (Space)">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" id="icon-play-svg"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </button>

            <!-- Skip Back 10s -->
            <button class="stream-ctrl-btn stream-skip-btn" id="btn-player-back10" title="Skip Backward 10s (←)">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
              </svg>
              <span>10</span>
            </button>

            <!-- Skip Forward 10s -->
            <button class="stream-ctrl-btn stream-skip-btn" id="btn-player-fwd10" title="Skip Forward 10s (→)">
              <span>10</span>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
            </button>

            <!-- Volume -->
            <div class="stream-vol-wrap">
              <button class="stream-ctrl-btn" id="btn-player-mute" title="Mute/Unmute (M)">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
              </button>
              <input type="range" class="stream-vol-slider" id="player-vol-slider" min="0" max="1" step="0.05" value="1" />
            </div>

            <!-- Time Display -->
            <div class="stream-time-text" id="stream-time-display">0:00 / 0:00</div>
          </div>

          <div class="stream-btn-group">
            <!-- Episodes Button (for TV Series) -->
            <button class="stream-ctrl-btn" id="btn-player-episodes" title="Episodes & Seasons (E)" style="display: none; align-items: center; gap: 4px; font-size: 12px; font-weight: 700; padding: 6px 10px; background: rgba(255,255,255,0.08); border-radius: 6px;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="2" y="7" width="20" height="15" rx="2" ry="2"/>
                <polyline points="17 2 12 7 7 2"/>
              </svg>
              <span>Episodes</span>
            </button>

            <!-- Captions Quick Button -->
            <button class="stream-ctrl-btn" id="btn-player-captions" title="Subtitles & Captions (C)">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2" ry="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/></svg>
            </button>

            <!-- Smart TV Casting Button (Phase 4) -->
            <button class="stream-ctrl-btn" id="btn-player-cast" title="Cast to Smart TV / AirPlay">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8A13 13 0 0 1 14 20M21 3H3a2 2 0 0 0-2 2v3h2V5h18v14h-7v2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/></svg>
            </button>

            <!-- Quality Pill -->
            <button class="stream-ctrl-btn" id="btn-player-quality-pill" title="Current Quality" style="font-size: 11px; font-weight: 800; background: rgba(255,255,255,0.1); padding: 4px 8px;">
              1080p
            </button>

            <!-- Settings Gear Button -->
            <button class="stream-ctrl-btn" id="btn-player-settings" title="Streamo Customizations & Settings">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>

            <!-- Lock Screen Button -->
            <button class="stream-ctrl-btn stream-lock-btn touch-target" id="btn-player-lock-bottom" title="Lock Screen (L)">
              <span class="stream-lock-icon stream-lock-icon-bottom">🔒</span>
            </button>

            <!-- PiP -->
            <button class="stream-ctrl-btn" id="btn-player-pip" title="Picture-in-Picture">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><rect x="12" y="9" width="8" height="6" rx="1" ry="1"/></svg>
            </button>

            <!-- Fullscreen -->
            <button class="stream-ctrl-btn" id="btn-player-fullscreen" title="Fullscreen (F)">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
            </button>
          </div>
        </div>
      </div>
    `;
    this.container.appendChild(this.controlsOverlay);

    // Create Lock Screen Overlay (Fix 5)
    this.lockOverlay = document.createElement('div');
    this.lockOverlay.className = 'player-lock-overlay';
    this.lockOverlay.id = 'player-lock-overlay';
    this.lockOverlay.innerHTML = `
      <div class="unlock-hint" id="player-unlock-btn">
        <span class="unlock-icon" style="margin-right: 6px;">🔓</span>
        <span>Tap to unlock</span>
      </div>
    `;
    this.container.appendChild(this.lockOverlay);

    // Bind custom controls
    this._bindCustomControlEvents();
  }

  _bindCustomControlEvents() {
    const safeOn = (el, evt, fn) => {
      if (el && typeof el.addEventListener === 'function') {
        el.addEventListener(evt, fn);
      }
    };

    const playBtn = document.getElementById('btn-player-play');
    const back10Btn = document.getElementById('btn-player-back10');
    const fwd10Btn = document.getElementById('btn-player-fwd10');
    const muteBtn = document.getElementById('btn-player-mute');
    const volSlider = document.getElementById('player-vol-slider');
    const settingsBtn = document.getElementById('btn-player-settings');
    const captionsBtn = document.getElementById('btn-player-captions');
    const castBtn = document.getElementById('btn-player-cast');
    const fullscreenBtn = document.getElementById('btn-player-fullscreen');
    const pipBtn = document.getElementById('btn-player-pip');
    const progressBar = document.getElementById('stream-progress-bar');

    // Lock / Unlock Screen Toggle (Fix 5)
    this.isPlayerLocked = false;
    const toggleLock = (forceState) => {
      this.isPlayerLocked = typeof forceState === 'boolean' ? forceState : !this.isPlayerLocked;
      const topIcon = document.getElementById('stream-lock-icon');
      const bottomIcon = document.querySelector('.stream-lock-icon-bottom');
      const icons = [topIcon, bottomIcon].filter(Boolean);

      if (this.isPlayerLocked) {
        this.container.classList.add('player-locked');
        icons.forEach((ic) => {
          ic.textContent = '🔒';
          ic.classList.remove('anim-scale');
          void ic.offsetWidth;
          ic.classList.add('anim-scale');
        });
      } else {
        this.container.classList.remove('player-locked');
        icons.forEach((ic) => {
          ic.textContent = '🔓';
          ic.classList.remove('anim-scale');
          void ic.offsetWidth;
          ic.classList.add('anim-scale');
          setTimeout(() => {
            if (!this.isPlayerLocked) ic.textContent = '🔒';
          }, 1200);
        });
        this.showControlsTemporarily();
      }
    };

    safeOn(document.getElementById('btn-player-lock'), 'click', (e) => {
      e?.stopPropagation?.();
      toggleLock(true);
    });
    safeOn(document.getElementById('btn-player-lock-bottom'), 'click', (e) => {
      e?.stopPropagation?.();
      toggleLock(true);
    });
    safeOn(document.getElementById('player-unlock-btn'), 'click', (e) => {
      e?.stopPropagation?.();
      toggleLock(false);
    });
    safeOn(this.lockOverlay, 'click', (e) => {
      e?.stopPropagation?.();
      if (e.target.closest('#player-unlock-btn')) {
        toggleLock(false);
      } else {
        const hint = document.getElementById('player-unlock-btn');
        if (hint) {
          hint.style.transform = 'scale(1.12)';
          setTimeout(() => { hint.style.transform = ''; }, 200);
        }
      }
    });

    // Smart TV Cast Button Click
    safeOn(castBtn, 'click', (e) => {
      e?.stopPropagation?.();
      this.toggleCast();
    });

    // Play / Pause Click
    safeOn(playBtn, 'click', (e) => {
      e?.stopPropagation?.();
      this.togglePlayPause();
    });

    // Video Click to Play/Pause
    safeOn(this.video, 'click', (e) => {
      e?.stopPropagation?.();
      this.togglePlayPause();
    });

    // Double click to Fullscreen
    safeOn(this.video, 'dblclick', () => {
      this.toggleFullscreen();
    });

    // Skip -10s
    safeOn(back10Btn, 'click', (e) => {
      e?.stopPropagation?.();
      this.seekRelative(-10);
      this.showSplashFeedback('-10s');
    });

    // Skip +10s
    safeOn(fwd10Btn, 'click', (e) => {
      e?.stopPropagation?.();
      this.seekRelative(10);
      this.showSplashFeedback('+10s');
    });

    // Mute / Unmute
    safeOn(muteBtn, 'click', (e) => {
      e?.stopPropagation?.();
      this.video.muted = !this.video.muted;
      if (volSlider) volSlider.value = this.video.muted ? 0 : this.video.volume;
    });

    // Volume Slider
    safeOn(volSlider, 'input', (e) => {
      e?.stopPropagation?.();
      this.video.volume = Number(e.target.value);
      this.video.muted = this.video.volume === 0;
    });

    const episodesBtn = document.getElementById('btn-player-episodes');

    // Episodes Drawer Toggle
    safeOn(episodesBtn, 'click', (e) => {
      e?.stopPropagation?.();
      this.toggleEpisodesDrawer();
    });

    // Settings Toggle
    safeOn(settingsBtn, 'click', (e) => {
      e?.stopPropagation?.();
      this.toggleSettingsMenu();
    });

    // Quality Pill click opens Quality Submenu directly
    const qualityPill = document.getElementById('btn-player-quality-pill');
    safeOn(qualityPill, 'click', (e) => {
      e?.stopPropagation?.();
      this.toggleSettingsMenu('quality');
    });

    // Captions Toggle (switch tab in settings menu or open menu)
    safeOn(captionsBtn, 'click', (e) => {
      e?.stopPropagation?.();
      this.toggleSettingsMenu('subtitles');
    });

    // Fullscreen Toggle
    safeOn(fullscreenBtn, 'click', (e) => {
      e?.stopPropagation?.();
      this.toggleFullscreen();
    });

    // Picture-in-Picture
    safeOn(pipBtn, 'click', async (e) => {
      e?.stopPropagation?.();
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else if (this.video.requestPictureInPicture) {
          await this.video.requestPictureInPicture();
        }
      } catch (err) {
        console.warn('PiP error:', err);
      }
    });

    // Interactive Scrubber
    safeOn(progressBar, 'click', (e) => {
      if (!progressBar.getBoundingClientRect) return;
      const rect = progressBar.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const targetSec = pos * (this.video.duration || 0);
      this.seekAbsolute(targetSec);
    });

    // Time Progress Updates
    safeOn(this.video, 'timeupdate', () => {
      this._updateProgressUI();
    });

    safeOn(this.video, 'progress', () => {
      this._updateBufferUI();
    });

    // Auto-hide controls on mouse idle
    const resetControlsTimer = () => {
      if (this.controlsOverlay?.classList) {
        this.controlsOverlay.classList.add('active');
      }
      clearTimeout(this.controlsTimeout);
      if (!this.video.paused) {
        this.controlsTimeout = setTimeout(() => {
          if (this.controlsOverlay?.classList) {
            this.controlsOverlay.classList.remove('active');
          }
          if (this.settingsMenu) this.settingsMenu.style.display = 'none';
        }, 3200);
      }
    };

    safeOn(this.container, 'mousemove', resetControlsTimer);
    safeOn(this.container, 'mouseenter', resetControlsTimer);
    safeOn(this.container, 'mouseleave', () => {
      if (!this.video.paused) {
        if (this.controlsOverlay?.classList) {
          this.controlsOverlay.classList.remove('active');
        }
        if (this.settingsMenu) this.settingsMenu.style.display = 'none';
      }
    });

    // Mobile touch & tap handling on video container
    let lastTap = 0;
    safeOn(this.container, 'click', (e) => {
      // If clicking inside control buttons or progress bar or settings, ignore container click
      if (e.target.closest('.stream-controls-bar') || e.target.closest('.streamo-settings-menu') || e.target.closest('.sync-hud')) {
        return;
      }

      const now = Date.now();
      const timeDiff = now - lastTap;
      
      if (timeDiff < 300 && timeDiff > 0) {
        // Double tap on mobile: skip 10s back or fwd
        const rect = this.container.getBoundingClientRect();
        const tapX = e.clientX - rect.left;
        if (tapX < rect.width * 0.35) {
          this.seekRelative(-10);
          this.showSplashFeedback('⏪ 10s');
        } else if (tapX > rect.width * 0.65) {
          this.seekRelative(10);
          this.showSplashFeedback('⏩ 10s');
        } else {
          this.togglePlayPause();
        }
        clearTimeout(this._tapTimeout);
      } else {
        // Single tap: toggle controls overlay
        this._tapTimeout = setTimeout(() => {
          if (this.controlsOverlay?.classList.contains('active')) {
            this.controlsOverlay.classList.remove('active');
            if (this.settingsMenu) this.settingsMenu.style.display = 'none';
            clearTimeout(this.controlsTimeout);
          } else {
            resetControlsTimer();
          }
        }, 220);
      }
      lastTap = now;
    });
  }

  showSplashFeedback(text) {
    if (!this.centerSplash) return;
    this.centerSplash.textContent = text;
    this.centerSplash.classList.add('show');
    clearTimeout(this._splashTimer);
    this._splashTimer = setTimeout(() => {
      this.centerSplash.classList.remove('show');
    }, 600);
  }

  togglePlayPause() {
    if (this.video.paused) {
      this.video.play().catch(() => {});
      this.showSplashFeedback('▶');
    } else {
      this.video.pause();
      this.showSplashFeedback('❚❚');
    }
  }

  seekRelative(deltaSeconds) {
    const current = this.video.currentTime || 0;
    const maxDur = this.video.duration || 99999;
    const target = Math.max(0, Math.min(maxDur, current + deltaSeconds));
    this.seekAbsolute(target);
  }

  seekAbsolute(targetSeconds) {
    this.video.currentTime = targetSeconds;
    // Notify room of seek action
    const ntpNow = this.getNtpNow();
    const currentMs = Math.round(targetSeconds * 1000);
    const rate = this.playbackSpeed || this.syncState?.rate || 1.0;
    this.syncState.position = currentMs;
    this.syncState.time = ntpNow;
    this.syncState.rate = rate;
    if (this.video.paused) {
      this.syncState.status = 'PAUS';
      this.syncState.paused = currentMs;
      this.syncState.started = null;
    } else {
      this.syncState.status = 'PLAY';
      this.syncState.started = Math.round(ntpNow - (currentMs / rate));
      this.syncState.paused = null;
    }
    this.wsSend({
      type: 'party',
      party: { sync: this.syncState }
    });
  }

  toggleFullscreen() {
    const isFs = document.fullscreenElement || 
                 document.webkitFullscreenElement || 
                 document.mozFullScreenElement || 
                 document.msFullscreenElement ||
                 this.video.webkitDisplayingFullscreen ||
                 this.container.classList.contains('is-pseudo-fullscreen');

    if (!isFs) {
      // 1. Standard HTML5 element fullscreen
      if (this.container.requestFullscreen) {
        this.container.requestFullscreen().catch(() => {
          this._enterNativeOrPseudoFullscreen();
        });
      } else if (this.container.webkitRequestFullscreen) {
        try {
          this.container.webkitRequestFullscreen();
        } catch {
          this._enterNativeOrPseudoFullscreen();
        }
      } else if (this.container.mozRequestFullScreen) {
        this.container.mozRequestFullScreen();
      } else if (this.container.msRequestFullscreen) {
        this.container.msRequestFullscreen();
      } else {
        this._enterNativeOrPseudoFullscreen();
      }
    } else {
      // Exit fullscreen
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      } else if (document.mozCancelFullScreen) {
        document.mozCancelFullScreen();
      } else if (document.msExitFullscreen) {
        document.msExitFullscreen();
      }

      if (this.video.webkitExitFullscreen) {
        try { this.video.webkitExitFullscreen(); } catch {}
      }
      this.container.classList.remove('is-pseudo-fullscreen');
      document.body.classList.remove('has-pseudo-fullscreen');
    }
  }

  _enterNativeOrPseudoFullscreen() {
    // iOS Safari native video fullscreen
    if (this.video.webkitEnterFullscreen) {
      try {
        this.video.webkitEnterFullscreen();
        return;
      } catch (err) {
        console.warn('[PartyPlayer] webkitEnterFullscreen fallback to pseudo-fullscreen:', err);
      }
    }
    // Universal pseudo-fullscreen fallback
    this.container.classList.add('is-pseudo-fullscreen');
    document.body.classList.add('has-pseudo-fullscreen');
  }

  _formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const sStr = s < 10 ? `0${s}` : `${s}`;
    if (h > 0) {
      const mStr = m < 10 ? `0${m}` : `${m}`;
      return `${h}:${mStr}:${sStr}`;
    }
    return `${m}:${sStr}`;
  }

  _updateProgressUI() {
    const cur = this.video.currentTime || 0;
    const dur = this.video.duration || 0;
    const playedEl = document.getElementById('stream-progress-played');
    const timeDisplay = document.getElementById('stream-time-display');

    if (playedEl) {
      const pct = (dur > 0 && isFinite(dur)) ? Math.max(0, Math.min(100, (cur / dur) * 100)) : 0;
      playedEl.style.width = `${pct}%`;
    }

    if (timeDisplay) {
      if (this.theme === 'netflix' && dur > 0 && isFinite(dur)) {
        const remaining = Math.max(0, dur - cur);
        timeDisplay.textContent = `-${this._formatTime(remaining)}`;
      } else {
        timeDisplay.textContent = `${this._formatTime(cur)} / ${this._formatTime(dur)}`;
      }
    }

    // Play/Pause icon update
    const playSvg = document.getElementById('icon-play-svg');
    if (playSvg) {
      if (this.video.paused) {
        playSvg.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
        this.container?.classList?.add?.('is-paused');
      } else {
        playSvg.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
        this.container?.classList?.remove?.('is-paused');
      }
    }
  }

  _updateBufferUI() {
    const bufferEl = document.getElementById('stream-progress-buffer');
    if (bufferEl && this.video.buffered.length > 0 && this.video.duration > 0) {
      const end = this.video.buffered.end(this.video.buffered.length - 1);
      const pct = (end / this.video.duration) * 100;
      bufferEl.style.width = `${pct}%`;
    }
  }

  /**
   * Builds the Streamo-Style Glassmorphic Settings Modal with tabs & submenus
   */
  _createSettingsMenu() {
    this.settingsMenu = document.createElement('div');
    this.settingsMenu.className = 'streamo-settings-menu';
    this.settingsMenu.innerHTML = `
      <!-- Mobile Drag Handle Bar -->
      <div class="mobile-sheet-handle-bar">
        <div style="font-weight: 700; font-size: 13px; color: #cbd5e1;">Theater Settings</div>
        <div class="mobile-sheet-handle"></div>
        <button class="mobile-sheet-close-btn" id="btn-close-settings-sheet">&times;</button>
      </div>

      <!-- Tabs -->
      <div class="settings-tabs">
        <button class="settings-tab-btn active" id="tab-playback-btn">Playback</button>
        <button class="settings-tab-btn" id="tab-subtitles-btn">Subtitles</button>
      </div>

      <div class="settings-content-pane">
        <!-- Main Playback View -->
        <div id="settings-view-main">
          <div class="settings-grid-cards">
            <div class="settings-stat-card" id="card-stat-quality">
              <div class="settings-card-label">⚙ Quality</div>
              <div class="settings-card-val" id="stat-val-quality">${this.currentQuality}</div>
            </div>
            <div class="settings-stat-card" id="card-stat-source">
              <div class="settings-card-label">🔥 Source</div>
              <div class="settings-card-val" id="stat-val-source">${this.currentProvider}</div>
            </div>
            <div class="settings-stat-card" id="card-stat-audio">
              <div class="settings-card-label">🔊 Audio</div>
              <div class="settings-card-val" id="stat-val-audio">150% Boost</div>
            </div>
            <div class="settings-stat-card" id="card-stat-style">
              <div class="settings-card-label">🖌 Style</div>
              <div class="settings-card-val" id="stat-val-style" style="text-transform: capitalize;">${this.theme}</div>
            </div>
          </div>

          <div class="settings-row" id="row-open-speed">
            <span>⏱ Speed</span>
            <span class="settings-row-val"><span id="row-val-speed">Normal</span> ›</span>
          </div>

          <div class="settings-row" id="row-open-brightness">
            <span>⚙ Brightness</span>
            <span class="settings-row-val"><span id="row-val-brightness">Normal</span> ›</span>
          </div>

          <div class="settings-row" id="row-open-booster">
            <span>🔊 Volume Booster</span>
            <span class="settings-row-val"><span id="row-val-booster">150% Clear Speech</span> ›</span>
          </div>

          <div class="settings-row" id="row-open-audio-tracks">
            <span>🎧 Audio Language Track</span>
            <span class="settings-row-val"><span id="row-val-audio-tracks">Default</span> ›</span>
          </div>

          <div class="settings-row">
            <span>📐 Fill Screen</span>
            <label class="stream-switch">
              <input type="checkbox" id="switch-fill-screen" ${this.isFillScreen ? 'checked' : ''} />
              <span class="stream-slider"></span>
            </label>
          </div>

          <div class="settings-row" id="row-open-febbox" style="margin-top: 6px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px; color: #f59e0b;">
            <span>🍪 Febbox 4K/VIP Cookies</span>
            <span class="settings-row-val" style="color: #fbbf24;">${this.febboxCookie ? 'Active' : 'Setup'} ›</span>
          </div>
        </div>

        <!-- Player Style Submenu View -->
        <div class="settings-submenu-view" id="settings-view-style">
          <div class="settings-submenu-header" id="back-from-style">
            ‹ Player Style
          </div>
          <div class="settings-option-item ${this.theme === 'streamo' ? 'selected' : ''}" data-theme="streamo">
            <span>Streamo (Indigo Glow)</span>
            <span>✓</span>
          </div>
          <div class="settings-option-item ${this.theme === 'netflix' ? 'selected' : ''}" data-theme="netflix">
            <span>Netflix (Red Scrubber & 10s Icons)</span>
            <span>✓</span>
          </div>
          <div class="settings-option-item ${this.theme === 'prime' ? 'selected' : ''}" data-theme="prime">
            <span>Prime Video (Electric Cyan)</span>
            <span>✓</span>
          </div>
          <div class="settings-option-item ${this.theme === 'cinema' ? 'selected' : ''}" data-theme="cinema">
            <span>Cinema (Theater Amber)</span>
            <span>✓</span>
          </div>
        </div>

        <!-- Speed Submenu View -->
        <div class="settings-submenu-view" id="settings-view-speed">
          <div class="settings-submenu-header" id="back-from-speed">
            ‹ Playback Speed
          </div>
          <div class="settings-option-item" data-speed="0.5"><span>0.5x</span></div>
          <div class="settings-option-item" data-speed="0.75"><span>0.75x</span></div>
          <div class="settings-option-item selected" data-speed="1.0"><span>1.0x (Normal)</span></div>
          <div class="settings-option-item" data-speed="1.25"><span>1.25x</span></div>
          <div class="settings-option-item" data-speed="1.5"><span>1.5x</span></div>
          <div class="settings-option-item" data-speed="2.0"><span>2.0x</span></div>
        </div>

        <!-- Brightness Submenu View -->
        <div class="settings-submenu-view" id="settings-view-brightness">
          <div class="settings-submenu-header" id="back-from-brightness">
            ‹ Brightness
          </div>
          <div class="settings-option-item" data-bright="80"><span>80% (Dark)</span></div>
          <div class="settings-option-item selected" data-bright="100"><span>100% (Normal)</span></div>
          <div class="settings-option-item" data-bright="120"><span>120% (Bright)</span></div>
          <div class="settings-option-item" data-bright="140"><span>140% (Vivid)</span></div>
        </div>

        <!-- Volume Booster Submenu View -->
        <div class="settings-submenu-view" id="settings-view-booster">
          <div class="settings-submenu-header" id="back-from-booster">
            ‹ Volume & Speech Clarity
          </div>
          <div class="settings-option-item" data-boost="1.0"><span>100% (Normal)</span></div>
          <div class="settings-option-item selected" data-boost="1.5"><span>150% (Clear Speech EQ)</span></div>
          <div class="settings-option-item" data-boost="2.0"><span>200% (Theater Boost)</span></div>
          <div class="settings-option-item" data-boost="3.0"><span>300% (Max Clarity)</span></div>
        </div>

        <!-- Subtitles Pane View -->
        <div class="settings-submenu-view" id="settings-view-subtitles">
          <!-- Party Subtitle Sync Badge -->
          <div class="settings-sync-badge" style="display: flex; align-items: center; justify-content: space-between; background: rgba(99, 102, 241, 0.15); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 8px; padding: 6px 12px; margin-bottom: 10px; font-size: 11px;">
            <span>👥 Party Subtitle Sync: <strong>Active</strong></span>
            <span style="color: #22c55e; font-weight: 700;">● In Sync</span>
          </div>

          <!-- Subtitle Delay Offset Controller (Phase 3) -->
          <div class="settings-offset-control" style="background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 8px 12px; margin-bottom: 10px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px; color: #cbd5e1; margin-bottom: 6px;">
              <span>⏱ Subtitle Timing Offset</span>
              <span id="subtitles-offset-val" style="font-weight: 700; color: #60a5fa;">0.0s</span>
            </div>
            <div style="display: flex; gap: 8px; align-items: center;">
              <button class="settings-offset-btn" id="sub-offset-minus" style="flex: 1; padding: 5px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #fff; font-size: 11px; cursor: pointer;">-0.2s</button>
              <button class="settings-offset-btn" id="sub-offset-reset" style="padding: 5px 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; color: #94a3b8; font-size: 10px; cursor: pointer;">Reset</button>
              <button class="settings-offset-btn" id="sub-offset-plus" style="flex: 1; padding: 5px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #fff; font-size: 11px; cursor: pointer;">+0.2s</button>
            </div>
          </div>

          <input type="text" id="subtitles-search-filter" placeholder="Search language (e.g. English, Spanish)..." style="width: 100%; padding: 8px 12px; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; color: #fff; font-size: 12px; margin-bottom: 10px;" />
          <div id="subtitles-list-container" style="max-height: 220px; overflow-y: auto;">
            <div class="settings-option-item selected" data-sub-url=""><span>Subtitles Off</span></div>
          </div>
        </div>

        <!-- Audio Language Tracks Submenu View (Phase 3) -->
        <div class="settings-submenu-view" id="settings-view-audio-tracks">
          <div class="settings-submenu-header" id="back-from-audio-tracks">
            ‹ Audio Language Track
          </div>
          <div id="settings-audio-tracks-list" style="max-height: 260px; overflow-y: auto;">
            <div class="settings-option-item selected settings-audio-track-item" data-track-id="-1"><span>Default Stream Audio</span></div>
          </div>
        </div>

        <!-- Video Quality Submenu View -->
        <div class="settings-submenu-view" id="settings-view-quality">
          <div class="settings-submenu-header" id="back-from-quality">
            ‹ Video Quality
          </div>
          <div id="settings-quality-list" style="max-height: 260px; overflow-y: auto;">
          </div>
        </div>

        <!-- Provider Source Submenu View -->
        <div class="settings-submenu-view" id="settings-view-source">
          <div class="settings-submenu-header" id="back-from-source">
            ‹ Streaming Source & Providers
          </div>
          <div id="settings-source-list" style="max-height: 260px; overflow-y: auto;">
          </div>
        </div>
      </div>
    `;
    
    // Append to document.body so modal escapes any video container clipping
    if (typeof document?.body?.appendChild === 'function') {
      document.body.appendChild(this.settingsMenu);
    } else if (typeof this.container?.appendChild === 'function') {
      this.container.appendChild(this.settingsMenu);
    }

    if (typeof document?.createElement === 'function') {
      this.settingsBackdrop = document.createElement('div');
      this.settingsBackdrop.className = 'streamo-settings-backdrop';
      if (typeof document?.body?.appendChild === 'function') {
        document.body.appendChild(this.settingsBackdrop);
      }
      if (typeof this.settingsBackdrop?.addEventListener === 'function') {
        this.settingsBackdrop.addEventListener('click', () => {
          this.toggleSettingsMenu(false);
        });
      }
    }

    const closeBtn = document.getElementById?.('btn-close-settings-sheet');
    if (typeof closeBtn?.addEventListener === 'function') {
      closeBtn.addEventListener('click', () => {
        this.toggleSettingsMenu(false);
      });
    }

    this._bindSettingsEvents();
  }

  _bindSettingsEvents() {
    const tabPlayback = document.getElementById('tab-playback-btn');
    const tabSubtitles = document.getElementById('tab-subtitles-btn');
    const viewMain = document.getElementById('settings-view-main');
    const viewSubtitles = document.getElementById('settings-view-subtitles');
    const viewStyle = document.getElementById('settings-view-style');
    const viewSpeed = document.getElementById('settings-view-speed');
    const viewBright = document.getElementById('settings-view-brightness');
    const viewBooster = document.getElementById('settings-view-booster');
    const viewAudioTracks = document.getElementById('settings-view-audio-tracks');
    const viewQuality = document.getElementById('settings-view-quality');
    const viewSource = document.getElementById('settings-view-source');

    const hideAllViews = () => {
      viewMain.style.display = 'none';
      viewSubtitles.style.display = 'none';
      viewStyle.style.display = 'none';
      viewSpeed.style.display = 'none';
      viewBright.style.display = 'none';
      viewBooster.style.display = 'none';
      if (viewAudioTracks) viewAudioTracks.style.display = 'none';
      if (viewQuality) viewQuality.style.display = 'none';
      if (viewSource) viewSource.style.display = 'none';
    };

    const safeOn = (el, evt, fn) => {
      if (el && typeof el.addEventListener === 'function') {
        el.addEventListener(evt, fn);
      }
    };

    // Tab Navigation
    safeOn(tabPlayback, 'click', (e) => {
      e?.stopPropagation?.();
      tabPlayback.classList?.add('active');
      tabSubtitles?.classList?.remove('active');
      hideAllViews();
      if (viewMain) viewMain.style.display = 'block';
    });

    safeOn(tabSubtitles, 'click', (e) => {
      e?.stopPropagation?.();
      tabSubtitles?.classList?.add('active');
      tabPlayback?.classList?.remove('active');
      hideAllViews();
      if (viewSubtitles) viewSubtitles.style.display = 'block';
      this._renderSubtitlesList();
    });

    // Submenu Triggers
    safeOn(document.getElementById('card-stat-quality'), 'click', () => {
      hideAllViews();
      if (viewQuality) viewQuality.style.display = 'block';
      this._renderQualitySubmenu();
    });
    safeOn(document.getElementById('card-stat-source'), 'click', () => {
      hideAllViews();
      if (viewSource) viewSource.style.display = 'block';
      this._renderSourceSubmenu();
    });
    safeOn(document.getElementById('card-stat-style'), 'click', () => {
      hideAllViews();
      if (viewStyle) viewStyle.style.display = 'block';
    });
    safeOn(document.getElementById('row-open-speed'), 'click', () => {
      hideAllViews();
      if (viewSpeed) viewSpeed.style.display = 'block';
    });
    safeOn(document.getElementById('card-stat-audio'), 'click', () => {
      hideAllViews();
      if (viewBooster) viewBooster.style.display = 'block';
    });
    safeOn(document.getElementById('row-open-booster'), 'click', () => {
      hideAllViews();
      if (viewBooster) viewBooster.style.display = 'block';
    });
    safeOn(document.getElementById('row-open-audio-tracks'), 'click', () => {
      hideAllViews();
      if (viewAudioTracks) viewAudioTracks.style.display = 'block';
      this._renderAudioTracksSubmenu();
    });
    safeOn(document.getElementById('row-open-brightness'), 'click', () => {
      hideAllViews();
      if (viewBright) viewBright.style.display = 'block';
    });
    safeOn(document.getElementById('row-open-febbox'), 'click', () => {
      this.openFebboxModal();
    });

    // Submenu Back Buttons
    safeOn(document.getElementById('back-from-audio-tracks'), 'click', () => {
      hideAllViews();
      if (viewMain) viewMain.style.display = 'block';
    });

    // Subtitle Offset Buttons (Phase 3)
    safeOn(document.getElementById('sub-offset-minus'), 'click', (e) => {
      e?.stopPropagation?.();
      this.applySubtitleOffset(this.subtitleOffsetMs - 200);
      if (this.onTracksChange && this.activeSubtitleUrl) {
        this.onTracksChange({ subtitle: { url: this.activeSubtitleUrl, offsetMs: this.subtitleOffsetMs } });
      }
    });
    safeOn(document.getElementById('sub-offset-reset'), 'click', (e) => {
      e?.stopPropagation?.();
      this.applySubtitleOffset(0);
      if (this.onTracksChange && this.activeSubtitleUrl) {
        this.onTracksChange({ subtitle: { url: this.activeSubtitleUrl, offsetMs: 0 } });
      }
    });
    safeOn(document.getElementById('sub-offset-plus'), 'click', (e) => {
      e?.stopPropagation?.();
      this.applySubtitleOffset(this.subtitleOffsetMs + 200);
      if (this.onTracksChange && this.activeSubtitleUrl) {
        this.onTracksChange({ subtitle: { url: this.activeSubtitleUrl, offsetMs: this.subtitleOffsetMs } });
      }
    });

    // Submenu Back Buttons
    safeOn(document.getElementById('back-from-quality'), 'click', () => {
      hideAllViews();
      if (viewMain) viewMain.style.display = 'block';
    });
    safeOn(document.getElementById('back-from-source'), 'click', () => {
      hideAllViews();
      if (viewMain) viewMain.style.display = 'block';
    });
    safeOn(document.getElementById('back-from-style'), 'click', () => {
      hideAllViews();
      if (viewMain) viewMain.style.display = 'block';
    });
    safeOn(document.getElementById('back-from-speed'), 'click', () => {
      hideAllViews();
      if (viewMain) viewMain.style.display = 'block';
    });
    safeOn(document.getElementById('back-from-brightness'), 'click', () => {
      hideAllViews();
      if (viewMain) viewMain.style.display = 'block';
    });
    safeOn(document.getElementById('back-from-booster'), 'click', () => {
      hideAllViews();
      if (viewMain) viewMain.style.display = 'block';
    });

    // Player Theme selection
    viewStyle?.querySelectorAll?.('.settings-option-item')?.forEach?.((item) => {
      safeOn(item, 'click', (e) => {
        const theme = item.getAttribute('data-theme');
        this.setTheme(theme);
        viewStyle?.querySelectorAll?.('.settings-option-item')?.forEach?.(i => i.classList?.remove('selected'));
        item.classList?.add('selected');
        const statEl = document.getElementById('stat-val-style');
        if (statEl) statEl.textContent = theme;
        hideAllViews();
        if (viewMain) viewMain.style.display = 'block';
      });
    });

    // Playback Speed selection
    viewSpeed?.querySelectorAll?.('.settings-option-item')?.forEach?.((item) => {
      safeOn(item, 'click', (e) => {
        const speed = Number(item.getAttribute('data-speed'));
        this.setPlaybackSpeed(speed);
        viewSpeed?.querySelectorAll?.('.settings-option-item')?.forEach?.(i => i.classList?.remove('selected'));
        item.classList?.add('selected');
        const rowVal = document.getElementById('row-val-speed');
        if (rowVal) rowVal.textContent = `${speed}x`;
        hideAllViews();
        if (viewMain) viewMain.style.display = 'block';
      });
    });

    // Brightness selection
    viewBright?.querySelectorAll?.('.settings-option-item')?.forEach?.((item) => {
      safeOn(item, 'click', (e) => {
        const b = Number(item.getAttribute('data-bright'));
        this.setBrightness(b);
        viewBright?.querySelectorAll?.('.settings-option-item')?.forEach?.(i => i.classList?.remove('selected'));
        item.classList?.add('selected');
        const rowVal = document.getElementById('row-val-brightness');
        if (rowVal) rowVal.textContent = `${b}%`;
        hideAllViews();
        if (viewMain) viewMain.style.display = 'block';
      });
    });

    // Volume Booster selection
    viewBooster?.querySelectorAll?.('.settings-option-item')?.forEach?.((item) => {
      safeOn(item, 'click', (e) => {
        const boost = Number(item.getAttribute('data-boost'));
        this.audioEnhancer.setBoost(boost);
        viewBooster?.querySelectorAll?.('.settings-option-item')?.forEach?.(i => i.classList?.remove('selected'));
        item.classList?.add('selected');
        const statEl = document.getElementById('stat-val-audio');
        const rowVal = document.getElementById('row-val-booster');
        if (statEl) statEl.textContent = `${Math.round(boost * 100)}% Boost`;
        if (rowVal) rowVal.textContent = `${Math.round(boost * 100)}% Boost`;
        hideAllViews();
        if (viewMain) viewMain.style.display = 'block';
      });
    });

    // Fill Screen Toggle
    safeOn(document.getElementById('switch-fill-screen'), 'change', (e) => {
      this.isFillScreen = e?.target?.checked;
      this.video.style.objectFit = this.isFillScreen ? 'cover' : 'contain';
    });

    // Subtitle Search Filter
    safeOn(document.getElementById('subtitles-search-filter'), 'input', (e) => {
      this._renderSubtitlesList(e?.target?.value);
    });
  }

  toggleSettingsMenu(tabName = 'playback') {
    if (!this.settingsMenu) return;

    if (tabName === false) {
      this.settingsMenu.style.display = 'none';
      if (this.settingsBackdrop) this.settingsBackdrop.style.display = 'none';
      return;
    }

    const isVisible = this.settingsMenu.style.display === 'flex';
    if (isVisible && tabName === 'playback') {
      this.settingsMenu.style.display = 'none';
      if (this.settingsBackdrop) this.settingsBackdrop.style.display = 'none';
    } else {
      this.settingsMenu.style.display = 'flex';
      this._positionSettingsMenu();

      if (window.innerWidth <= 640 && this.settingsBackdrop) {
        this.settingsBackdrop.style.display = 'block';
      } else if (this.settingsBackdrop) {
        this.settingsBackdrop.style.display = 'none';
      }

      if (tabName === 'subtitles') {
        document.getElementById('tab-subtitles-btn')?.click();
      } else if (tabName === 'quality') {
        document.getElementById('tab-playback-btn')?.click();
        document.getElementById('card-stat-quality')?.click();
      } else if (tabName === 'source') {
        document.getElementById('tab-playback-btn')?.click();
        document.getElementById('card-stat-source')?.click();
      } else {
        document.getElementById('tab-playback-btn')?.click();
      }
    }
  }

  _positionSettingsMenu() {
    if (!this.settingsMenu) return;
    if (window.innerWidth <= 640) {
      this.settingsMenu.style.position = 'fixed';
      this.settingsMenu.style.bottom = '0px';
      this.settingsMenu.style.left = '0px';
      this.settingsMenu.style.right = '0px';
      this.settingsMenu.style.top = 'auto';
      this.settingsMenu.style.width = '100vw';
      this.settingsMenu.style.maxWidth = '100vw';
      this.settingsMenu.style.borderRadius = '20px 20px 0 0';
    } else {
      const rect = this.container.getBoundingClientRect();
      this.settingsMenu.style.position = 'fixed';
      this.settingsMenu.style.bottom = `${Math.max(10, window.innerHeight - rect.bottom + 65)}px`;
      this.settingsMenu.style.right = `${Math.max(10, window.innerWidth - rect.right + 18)}px`;
      this.settingsMenu.style.left = 'auto';
      this.settingsMenu.style.top = 'auto';
      this.settingsMenu.style.width = '320px';
      this.settingsMenu.style.maxWidth = '90vw';
      this.settingsMenu.style.borderRadius = '16px';
    }
  }

  _renderQualitySubmenu() {
    const listEl = document.getElementById('settings-quality-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const safeOn = (el, evt, fn) => {
      if (el && typeof el.addEventListener === 'function') {
        el.addEventListener(evt, fn);
      }
    };

    // Build quality options list
    const standardQualities = ['Auto', '4K', '1080p', '720p', '480p', '360p'];

    standardQualities.forEach((q) => {
      const isSelected = (q === 'Auto' && !this.preferredQuality) ||
        (this.preferredQuality === q) ||
        (!this.preferredQuality && this.currentQuality?.toLowerCase() === q.toLowerCase());

      const is4K = q === '4K';
      const item = document.createElement('div');
      item.className = `settings-option-item ${isSelected ? 'selected' : ''}`;
      item.style.cursor = 'pointer';
      item.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px;">
          <span>${q}</span>
          ${is4K && this.febboxCookie ? '<span style="font-size: 10px; font-weight: 800; background: #f59e0b; color: #000; padding: 1px 6px; border-radius: 4px;">VIP</span>' : ''}
        </div>
        ${isSelected ? '<span>✓</span>' : ''}
      `;

      safeOn(item, 'click', async () => {
        const selectedQ = q === 'Auto' ? null : q;
        this.preferredQuality = selectedQ;
        const statQ = document.getElementById('stat-val-quality');
        const pillQ = document.getElementById('btn-player-quality-pill');
        if (statQ) statQ.textContent = q;
        if (pillQ) pillQ.textContent = q;

        this.settingsMenu.style.display = 'none';
        const curSec = this.video.currentTime || 0;
        await this.loadStream({
          ...this.currentVideo,
          preferredQuality: selectedQ,
          preferredProvider: this.currentProvider,
          startAt: curSec,
        });
      });

      listEl.appendChild(item);
    });
  }

  _renderSourceSubmenu() {
    const listEl = document.getElementById('settings-source-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const safeOn = (el, evt, fn) => {
      if (el && typeof el.addEventListener === 'function') {
        el.addEventListener(evt, fn);
      }
    };

    const providers = this.availableProviders && this.availableProviders.length > 0
      ? this.availableProviders
      : [{ name: this.currentProvider || 'Edge', kind: 'relay', qualities: ['1080p'] }];

    providers.forEach((p) => {
      const isSelected = p.name === this.currentProvider;
      const item = document.createElement('div');
      item.className = `settings-option-item ${isSelected ? 'selected' : ''}`;
      item.style.cursor = 'pointer';
      const qBadges = (p.qualities || []).slice(0, 3).map(q => `<span style="font-size: 10px; background: rgba(255,255,255,0.1); padding: 1px 5px; border-radius: 3px;">${q}</span>`).join(' ');

      item.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; margin-right: 8px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-weight: 700;">${p.name}</span>
            ${p.kind ? `<span style="font-size: 10px; color: #94a3b8; text-transform: uppercase;">(${p.kind})</span>` : ''}
          </div>
          <div style="display: flex; gap: 4px;">
            ${qBadges}
          </div>
        </div>
        ${isSelected ? '<span>✓</span>' : ''}
      `;

      safeOn(item, 'click', async () => {
        this.currentProvider = p.name;
        this.preferredProvider = p.name;
        const statP = document.getElementById('stat-val-source');
        if (statP) statP.textContent = p.name;

        this.settingsMenu.style.display = 'none';
        const curSec = this.video.currentTime || 0;
        await this.loadStream({
          ...this.currentVideo,
          preferredProvider: p.name,
          preferredQuality: this.preferredQuality,
          startAt: curSec,
        });
      });

      listEl.appendChild(item);
    });
  }

  setTheme(themeName) {
    this.theme = themeName || 'streamo';
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('streamo:player-theme', this.theme);
    }
    if (this.container?.classList) {
      this.container.classList.remove('theme-streamo', 'theme-netflix', 'theme-prime', 'theme-cinema');
      this.container.classList.add(`theme-${this.theme}`);
    }

    const statEl = document.getElementById('stat-val-style');
    if (statEl) statEl.textContent = this.theme;

    this._updateProgressUI();
  }

  setPlaybackSpeed(speed) {
    this.playbackSpeed = speed;
    this.video.playbackRate = speed;
    this.syncState.rate = speed;
    // Broadcast rate change to watch party
    this.wsSend({
      type: 'party',
      party: { sync: this.syncState }
    });
  }

  setBrightness(percent) {
    this.brightness = percent;
    this.video.style.filter = `brightness(${percent}%)`;
  }

  getDesiredPositionMs() {
    if (!this.syncState) return 0;
    const isPaused = this.syncState.status === 'PAUS' || (this.syncState.paused !== null && this.syncState.paused !== undefined);
    if (isPaused) {
      return this.syncState.paused ?? this.syncState.position ?? 0;
    }
    const ntpNow = this.getNtpNow();
    if (!this.syncState.started) {
      return this.syncState.paused ?? this.syncState.position ?? 0;
    }
    const elapsed = Math.max(0, ntpNow - this.syncState.started);
    return Math.round(elapsed * (this.syncState.rate ?? 1.0));
  }

  syncToPosition(targetMs) {
    if (!this.video) return;
    const dur = this.video.duration;
    const targetSec = Math.max(0, targetMs / 1000);
    const safeTarget = (dur && isFinite(dur) && dur > 0) ? Math.min(targetSec, Math.max(0, dur - 0.5)) : targetSec;
    if (Math.abs((this.video.currentTime || 0) - safeTarget) > 0.05) {
      this.video.currentTime = safeTarget;
    }
  }

  async handleRemoteVideoChange(partyPayload, isFromSelf = false) {
    if (!partyPayload || isFromSelf) return;
    if (partyPayload.video) {
      const newUrl = partyPayload.video.url;
      const newTmdbId = partyPayload.video.tmdbId ? Number(partyPayload.video.tmdbId) : null;
      const isTv = partyPayload.video.type === 'tv';

      const isSameVideo = this.currentVideo &&
        this.currentVideo.url === newUrl &&
        this.currentVideo.tmdbId === newTmdbId &&
        this.currentVideo.season === partyPayload.video.season &&
        this.currentVideo.episode === partyPayload.video.episode;

      this.currentVideo = { ...partyPayload.video };

      const epBtn = document.getElementById('btn-player-episodes');
      if (epBtn) {
        epBtn.style.display = isTv ? 'inline-flex' : 'none';
        if (isTv) {
          epBtn.title = `Switch Season/Episode (Current: S${String(partyPayload.video.season || 1).padStart(2, '0')}E${String(partyPayload.video.episode || 1).padStart(2, '0')})`;
        }
      }
      if (isTv && newTmdbId) {
        this._loadSeriesSeasonsForDrawer(newTmdbId);
      }

      if (!isSameVideo) {
        if (newUrl) {
          const vTitle = partyPayload.video?.title || 'Party Stream';
          this.showLoading(`Loading ${vTitle}...`, 'Buffering video stream in sync with host...');
          let streamReady = false;
          const onStreamActive = () => {
            if (streamReady) return;
            streamReady = true;
            this.hideLoading();
            this.video.removeEventListener('playing', onStreamActive);
            this.video.removeEventListener('canplay', onStreamActive);
          };
          this.video.addEventListener('playing', onStreamActive, { once: true });
          this.video.addEventListener('canplay', onStreamActive, { once: true });
          setTimeout(onStreamActive, 10000);

          await this.attachStream(newUrl, partyPayload.video.subtitlesUrl);
        } else if (newTmdbId) {
          await this.loadStream(partyPayload.video);
        }
      }
    }
    if (partyPayload.sync) {
      this.applySync(partyPayload.sync);
    }
  }

  _renderSubtitlesList(searchQuery = '') {
    const listEl = document.getElementById('subtitles-list-container');
    if (!listEl) return;
    listEl.innerHTML = '';

    const safeOn = (el, evt, fn) => {
      if (el && typeof el.addEventListener === 'function') {
        el.addEventListener(evt, fn);
      }
    };

    // "Off" option
    const offItem = document.createElement('div');
    offItem.className = `settings-option-item ${!this.activeSubtitleUrl ? 'selected' : ''}`;
    offItem.innerHTML = '<span>Subtitles Off</span><span>✓</span>';
    safeOn(offItem, 'click', () => {
      this.setSubtitleTrack(null);
      this._renderSubtitlesList(searchQuery);
    });
    if (typeof listEl.appendChild === 'function') {
      listEl.appendChild(offItem);
    }

    const q = searchQuery.toLowerCase().trim();
    const filtered = this.subtitleTracks.filter(t => !q || t.label.toLowerCase().includes(q) || t.language.toLowerCase().includes(q));

    for (const track of filtered) {
      const isSelected = this.activeSubtitleUrl === track.url;
      const item = document.createElement('div');
      item.className = `settings-option-item ${isSelected ? 'selected' : ''}`;
      item.innerHTML = `<span>${track.label} (${track.language.toUpperCase()})</span><span>${isSelected ? '✓' : ''}</span>`;
      safeOn(item, 'click', () => {
        this.setSubtitleTrack(track.url, track.label);
        this._renderSubtitlesList(searchQuery);
      });
      if (typeof listEl.appendChild === 'function') {
        listEl.appendChild(item);
      }
    }
  }

  /**
   * Populate available audio language tracks from HLS
   */
  _populateAudioTracks(tracks = []) {
    if (!tracks || !Array.isArray(tracks)) return;
    this.audioTracks = tracks;
    if (this.hls && this.hls.audioTrack !== undefined) {
      this.selectedAudioTrackId = this.hls.audioTrack;
    }
    const current = tracks.find(t => t.id === this.selectedAudioTrackId);
    const label = current ? (current.name || current.lang || `Track ${current.id + 1}`) : 'Default';
    const rowVal = document.getElementById('row-val-audio-tracks');
    if (rowVal) rowVal.textContent = label;
  }

  /**
   * Render Audio Language Tracks Submenu View
   */
  _renderAudioTracksSubmenu() {
    const listEl = document.getElementById('settings-audio-tracks-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const safeOn = (el, evt, fn) => {
      if (el && typeof el.addEventListener === 'function') {
        el.addEventListener(evt, fn);
      }
    };

    if (!this.audioTracks || this.audioTracks.length === 0) {
      const defaultItem = document.createElement('div');
      defaultItem.className = 'settings-option-item selected settings-audio-track-item';
      defaultItem.setAttribute('data-track-id', '-1');
      defaultItem.innerHTML = '<span>Default Stream Audio (Stereo)</span><span>✓</span>';
      listEl.appendChild(defaultItem);
      return;
    }

    this.audioTracks.forEach((track) => {
      const isSelected = track.id === this.selectedAudioTrackId;
      const item = document.createElement('div');
      item.className = `settings-option-item settings-audio-track-item ${isSelected ? 'selected' : ''}`;
      item.setAttribute('data-track-id', track.id);
      const name = track.name || track.lang || `Audio Track ${track.id + 1}`;
      item.innerHTML = `<span>${escapeHtml(name)} ${track.lang ? `[${track.lang.toUpperCase()}]` : ''}</span><span>${isSelected ? '✓' : ''}</span>`;
      safeOn(item, 'click', () => {
        this.setAudioTrack(track.id);
        this._renderAudioTracksSubmenu();
      });
      listEl.appendChild(item);
    });
  }

  /**
   * Febbox Cookie Modal Setup & Validation
   */
  _createFebboxModal() {
    this.febboxModal = document.createElement('div');
    this.febboxModal.className = 'febbox-modal-backdrop';
    this.febboxModal.innerHTML = `
      <div class="febbox-modal-card">
        <div class="febbox-modal-header">
          <div style="display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 16px;">
            <span>🍪</span>
            <span>Febbox Cookies Setup</span>
          </div>
          <button id="close-febbox-modal" style="background: none; border: none; color: #94a3b8; font-size: 18px; cursor: pointer;">✕</button>
        </div>
        <div class="febbox-modal-body">
          <div class="febbox-callout">
            <strong>What are Febbox cookies and why add them?</strong><br>
            Adding your Febbox cookie unlocks the best available quality for everything you stream — <strong>1080p and 4K uncompressed streams</strong> with 18+ high-speed providers (Raven, Showbox, Cobalt, Orion) that aren't available to guests.
            A free account from <a href="https://www.febbox.com" target="_blank" style="color: #60a5fa; text-decoration: underline;">febbox.com</a> gives you 20GB/day of high-speed bandwidth!
          </div>

          <label style="font-size: 12px; font-weight: 700; color: #cbd5e1; margin-bottom: 6px; display: block;">
            Paste Febbox Cookie Value:
          </label>
          <input type="text" class="febbox-input" id="febbox-cookie-input" value="${this.febboxCookie}" placeholder="ui=...; token=..." />

          <div id="febbox-test-status" style="font-size: 12px; margin-bottom: 16px; display: none;"></div>

          <div style="display: flex; gap: 10px; justify-content: flex-end;">
            <button class="btn btn-secondary" id="btn-cancel-febbox" style="padding: 10px 18px; font-size: 13px;">Cancel</button>
            <button class="btn btn-primary" id="btn-save-febbox" style="padding: 10px 20px; font-size: 13px;">Test & Save Cookie</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(this.febboxModal);

    const safeOn = (el, evt, fn) => {
      if (el && typeof el.addEventListener === 'function') {
        el.addEventListener(evt, fn);
      }
    };

    safeOn(document.getElementById('close-febbox-modal'), 'click', () => {
      this.febboxModal.style.display = 'none';
    });
    safeOn(document.getElementById('btn-cancel-febbox'), 'click', () => {
      this.febboxModal.style.display = 'none';
    });

    safeOn(document.getElementById('btn-save-febbox'), 'click', async () => {
      const val = document.getElementById('febbox-cookie-input').value.trim();
      const statusEl = document.getElementById('febbox-test-status');
      statusEl.style.display = 'block';
      statusEl.innerHTML = '<span style="color: #60a5fa;">Testing cookie with Streamo streaming engine...</span>';

      try {
        const res = await fetch('/api/media/febbox-test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookie: val }),
        });
        const data = await res.json();
        if (data.valid) {
          this.febboxCookie = val;
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('streamo:febbox-cookies', val);
          }
          statusEl.innerHTML = '<span style="color: #22c55e; font-weight: 700;">✓ Cookie Validated! 1080p & 4K streams unlocked.</span>';
          document.getElementById('row-open-febbox').querySelector('.settings-row-val').innerHTML = '<span style="color: #22c55e;">Active ✓</span>';
          setTimeout(() => {
            this.febboxModal.style.display = 'none';
            if (this.currentVideo) {
              this.loadStream(this.currentVideo);
            }
          }, 1200);
        } else {
          statusEl.innerHTML = `<span style="color: #ef4444;">✗ ${data.error || 'Invalid cookie. Please check and try again.'}</span>`;
        }
      } catch (err) {
        statusEl.innerHTML = `<span style="color: #ef4444;">Error testing cookie: ${err.message}</span>`;
      }
    });
  }

  _createEpisodesDrawer() {
    this.episodesDrawer = document.createElement('div');
    this.episodesDrawer.className = 'stream-episodes-drawer';
    this.episodesDrawer.innerHTML = `
      <div class="stream-ep-drawer-header">
        <div class="stream-ep-drawer-title">
          <span>📺</span>
          <span id="stream-ep-drawer-heading">Episodes</span>
        </div>
        <button class="stream-ep-drawer-close" id="btn-close-ep-drawer">&times;</button>
      </div>
      <div class="stream-ep-season-select-wrap">
        <select class="stream-ep-season-dropdown" id="stream-ep-season-select"></select>
      </div>
      <div class="stream-ep-list" id="stream-ep-list">
        <div style="text-align: center; color: #94a3b8; padding: 30px;">Loading episodes...</div>
      </div>
    `;
    this.container.appendChild(this.episodesDrawer);

    const safeOn = (el, evt, fn) => {
      if (el && typeof el.addEventListener === 'function') {
        el.addEventListener(evt, fn);
      }
    };

    safeOn(document.getElementById('btn-close-ep-drawer'), 'click', () => {
      this.episodesDrawer.classList.remove('open');
    });

    safeOn(document.getElementById('stream-ep-season-select'), 'change', (e) => {
      const sNum = Number(e.target.value);
      this._renderEpisodesInDrawer(sNum);
    });
  }

  async _loadSeriesSeasonsForDrawer(tmdbId) {
    if (!tmdbId) return;
    const numId = Number(tmdbId);

    // If already loaded for this series, re-populate and return
    if (this.currentSeriesDetails && Number(this.currentSeriesDetails.tmdbId) === numId && this.currentSeriesDetails.seasons?.length > 0) {
      this._populateSeasonDropdown(this.currentSeriesDetails.seasons);
      return;
    }

    // Reuse in-flight fetch promise if already loading
    if (this._loadingSeriesPromise && this._loadingSeriesTmdbId === numId) {
      try {
        await this._loadingSeriesPromise;
        if (this.currentSeriesDetails?.seasons) {
          this._populateSeasonDropdown(this.currentSeriesDetails.seasons);
        }
      } catch {}
      return;
    }

    const listEl = document.getElementById('stream-ep-list');
    if (listEl) {
      listEl.innerHTML = `<div style="text-align: center; color: #94a3b8; padding: 30px;"><div style="display: inline-block; width: 22px; height: 22px; border: 3px solid rgba(255,255,255,0.2); border-top-color: #6366f1; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 8px;"></div><br>Loading episodes...</div>`;
    }

    this._loadingSeriesTmdbId = numId;
    this._loadingSeriesPromise = (async () => {
      try {
        const res = await fetch(`/api/media/tv/${numId}`);
        if (!res.ok) throw new Error(`TV fetch failed: HTTP ${res.status}`);
        const data = await res.json();
        this.currentSeriesDetails = data;
        this._populateSeasonDropdown(data.seasons || []);
      } catch (err) {
        console.warn('[PartyPlayer] Failed fetching series seasons:', err);
        if (listEl) {
          listEl.innerHTML = `<div style="text-align: center; color: #ef4444; padding: 24px;">Failed to load episodes. <button id="btn-retry-load-episodes" style="margin-top: 10px; background: #4f46e5; color: #fff; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; display: block; margin-left: auto; margin-right: auto;">Retry</button></div>`;
          document.getElementById('btn-retry-load-episodes')?.addEventListener('click', () => {
            this._loadingSeriesPromise = null;
            this._loadSeriesSeasonsForDrawer(numId);
          });
        }
      } finally {
        this._loadingSeriesPromise = null;
      }
    })();

    await this._loadingSeriesPromise;
  }

  _populateSeasonDropdown(seasons) {
    const select = document.getElementById('stream-ep-season-select');
    if (!select) return;
    select.innerHTML = '';

    const currentSeasonNum = Number(this.currentVideo?.season || 1);

    seasons.forEach((s) => {
      const sNum = Number(s.seasonNumber);
      const opt = document.createElement('option');
      opt.value = sNum;
      opt.textContent = s.name || `Season ${sNum}`;
      if (sNum === currentSeasonNum) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });

    this._renderEpisodesInDrawer(currentSeasonNum);
  }

  _renderEpisodesInDrawer(seasonNumber) {
    const listEl = document.getElementById('stream-ep-list');
    if (!listEl) return;

    const sNum = Number(seasonNumber);
    const seasons = this.currentSeriesDetails?.seasons || [];
    let curSeason = seasons.find((s) => Number(s.seasonNumber) === sNum);

    if (!curSeason && seasons.length > 0) {
      curSeason = seasons[0];
    }

    if (!curSeason || !curSeason.episodes || curSeason.episodes.length === 0) {
      listEl.innerHTML = `<div style="text-align: center; color: #64748b; padding: 24px;">No episodes found for this season.</div>`;
      return;
    }

    const curActiveEp = Number(this.currentVideo?.episode || 1);
    const curActiveSeason = Number(this.currentVideo?.season || 1);

    listEl.innerHTML = curSeason.episodes
      .map((ep) => {
        const epNum = Number(ep.episodeNumber);
        const isActive = curActiveSeason === Number(curSeason.seasonNumber) && curActiveEp === epNum;
        return `
          <div class="stream-ep-item ${isActive ? 'active' : ''}" data-season="${curSeason.seasonNumber}" data-episode="${epNum}">
            <img class="stream-ep-item-thumb" src="${ep.still || this.currentVideo?.poster || 'https://via.placeholder.com/160x90/1e293b/94a3b8?text=No+Still'}" alt="E${epNum}" />
            <div class="stream-ep-item-info">
              <span class="stream-ep-item-num">S${String(curSeason.seasonNumber).padStart(2, '0')} E${String(epNum).padStart(2, '0')}</span>
              <span class="stream-ep-item-title">${escapeHtml(ep.name)}</span>
              <span class="stream-ep-item-duration">${ep.runtime ? `${ep.runtime} min` : '45 min'}</span>
            </div>
          </div>
        `;
      })
      .join('');

    const safeOn = (el, evt, fn) => {
      if (el && typeof el.addEventListener === 'function') {
        el.addEventListener(evt, fn);
      }
    };

    listEl.querySelectorAll('.stream-ep-item').forEach((item) => {
      safeOn(item, 'click', async () => {
        const epSeason = Number(item.getAttribute('data-season'));
        const epNum = Number(item.getAttribute('data-episode'));
        const epData = curSeason.episodes.find((e) => Number(e.episodeNumber) === epNum);

        this.episodesDrawer.classList.remove('open');

        const seriesTitle = this.currentSeriesDetails?.title || this.currentVideo?.seriesTitle || 'TV Series';
        const formattedTitle = `${seriesTitle} - S${String(epSeason).padStart(2, '0')}E${String(epNum).padStart(2, '0')}${epData ? ' - ' + epData.name : ''}`;

        await this.loadStream({
          tmdbId: this.currentVideo.tmdbId,
          type: 'tv',
          season: epSeason,
          episode: epNum,
          title: formattedTitle,
          seriesTitle: seriesTitle,
          poster: epData?.still || this.currentVideo?.poster,
        });
      });
    });
  }

  toggleEpisodesDrawer() {
    if (!this.episodesDrawer) return;
    const isOpen = this.episodesDrawer.classList.contains('open');
    if (isOpen) {
      this.episodesDrawer.classList.remove('open');
    } else {
      this.episodesDrawer.classList.add('open');
      const targetTmdbId = this.currentVideo?.tmdbId;
      if (targetTmdbId && (!this.currentSeriesDetails || Number(this.currentSeriesDetails.tmdbId) !== Number(targetTmdbId))) {
        this._loadSeriesSeasonsForDrawer(targetTmdbId);
      } else if (this.currentSeriesDetails?.seasons?.length) {
        this._populateSeasonDropdown(this.currentSeriesDetails.seasons);
      } else if (targetTmdbId) {
        this._loadSeriesSeasonsForDrawer(targetTmdbId);
      }
    }
  }

  openFebboxModal() {
    if (this.febboxModal) {
      this.febboxModal.style.display = 'flex';
      if (this.settingsMenu) this.settingsMenu.style.display = 'none';
    }
  }

  showLoading(title = 'Finding best stream...', sub = 'Querying Edge and primary streaming sources...') {
    if (this.loadingOverlay) {
      const titleEl = document.getElementById('party-loader-title');
      const subEl = document.getElementById('party-loader-sub');
      if (titleEl) titleEl.textContent = title;
      if (subEl) subEl.textContent = sub;
      if (this.loadingOverlay.classList?.add) {
        this.loadingOverlay.classList.add('active');
      }
      if (typeof this.loadingOverlay.style?.setProperty === 'function') {
        this.loadingOverlay.style.setProperty('display', 'flex', 'important');
      } else if (this.loadingOverlay.style) {
        this.loadingOverlay.style.display = 'flex';
      }
    }
  }

  hideLoading() {
    if (this.loadingOverlay) {
      if (this.loadingOverlay.classList?.remove) {
        this.loadingOverlay.classList.remove('active');
      }
      if (typeof this.loadingOverlay.style?.setProperty === 'function') {
        this.loadingOverlay.style.setProperty('display', 'none', 'important');
      } else if (this.loadingOverlay.style) {
        this.loadingOverlay.style.display = 'none';
      }
    }
  }

  async showCountdown(seconds = 3) {
    if (!this.countdownOverlay) return;
    if (this.countdownOverlay.classList?.add) {
      this.countdownOverlay.classList.add('active');
    }
    if (typeof this.countdownOverlay.style?.setProperty === 'function') {
      this.countdownOverlay.style.setProperty('display', 'flex', 'important');
    } else if (this.countdownOverlay.style) {
      this.countdownOverlay.style.display = 'flex';
    }
    const numEl = document.getElementById('party-countdown-num');

    for (let i = seconds; i > 0; i--) {
      if (numEl) numEl.textContent = i;
      await new Promise((r) => setTimeout(r, 750));
    }

    this.hideCountdown();
  }

  hideCountdown() {
    if (this.countdownOverlay) {
      if (this.countdownOverlay.classList?.remove) {
        this.countdownOverlay.classList.remove('active');
      }
      if (typeof this.countdownOverlay.style?.setProperty === 'function') {
        this.countdownOverlay.style.setProperty('display', 'none', 'important');
      } else if (this.countdownOverlay.style) {
        this.countdownOverlay.style.display = 'none';
      }
    }
  }

  _showPlayPrompt() {
    let promptEl = document.getElementById('party-play-prompt');
    if (!promptEl && this.container) {
      promptEl = document.createElement('div');
      promptEl.id = 'party-play-prompt';
      promptEl.className = 'party-play-prompt';
      promptEl.innerHTML = `
        <div class="party-play-prompt-card">
          <div class="party-play-prompt-btn">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </div>
          <div class="party-play-prompt-text">Tap to Start Playback</div>
          <div class="party-play-prompt-sub">Audio & video ready — tap anywhere to watch</div>
        </div>
      `;
      this.container.appendChild(promptEl);
      if (typeof promptEl.addEventListener === 'function') {
        promptEl.addEventListener('click', async (e) => {
          e.stopPropagation();
          this._hidePlayPrompt();
          try {
            await this.video.play();
            // Root cause D fix: seek to computeDesiredPosition(Date.now()) after play resolves
            const freshDesiredMs = this.getDesiredPositionMs();
            this.syncToPosition(freshDesiredMs);
          } catch (err) {
            console.warn('[PartyPlayer] Play after tap failed:', err);
          }
        });
      }
    }
    if (promptEl) {
      if (promptEl.classList?.add) promptEl.classList.add('active');
      if (typeof promptEl.style?.setProperty === 'function') {
        promptEl.style.setProperty('display', 'flex', 'important');
      } else if (promptEl.style) {
        promptEl.style.display = 'flex';
      }
    }
  }

  _hidePlayPrompt() {
    const promptEl = document.getElementById('party-play-prompt');
    if (promptEl) {
      if (promptEl.classList?.remove) promptEl.classList.remove('active');
      if (typeof promptEl.style?.setProperty === 'function') {
        promptEl.style.setProperty('display', 'none', 'important');
      } else if (promptEl.style) {
        promptEl.style.display = 'none';
      }
    }
  }

  /**
   * Load a movie/show from the Streamo streaming pipeline
   */
  async loadStream(movie) {
    if (!movie || !movie.tmdbId) {
      console.warn('[PartyPlayer] Invalid movie passed to loadStream:', movie);
      alert('Could not start stream: Missing movie ID. Please pick a title from the catalog.');
      return;
    }

    const tmdbId = movie.tmdbId;
    const type = movie.type || 'movie';
    const title = movie.title || 'Selected Title';
    const season = movie.season || 1;
    const episode = movie.episode || 1;

    // Reset countdown and play prompt
    this.hideCountdown();
    this._hidePlayPrompt();

    // Streamo loading stage 1: Searching for best stream
    this.showLoading(`Finding best stream for ${title}...`, 'Connecting to Edge and primary streaming sources...');

    // Reset player position and UI to the beginning
    try {
      this.video.currentTime = 0;
      const playedEl = document.getElementById('stream-progress-played');
      if (playedEl) playedEl.style.width = '0%';
      const timeDisplay = document.getElementById('stream-time-display');
      if (timeDisplay) timeDisplay.textContent = '0:00 / 0:00';
    } catch {}

    try {
      const cookieParam = this.febboxCookie ? `&febboxCookie=${encodeURIComponent(this.febboxCookie)}` : '';
      const targetProvider = movie.preferredProvider || this.preferredProvider;
      const providerParam = targetProvider ? `&provider=${encodeURIComponent(targetProvider)}` : '';
      const targetQuality = movie.preferredQuality || this.preferredQuality;
      const qualityParam = targetQuality ? `&quality=${encodeURIComponent(targetQuality)}` : '';

      const queryParams =
        type === 'tv'
          ? `type=tv&season=${season}&episode=${episode}${cookieParam}${providerParam}${qualityParam}`
          : `type=movie${cookieParam}${providerParam}${qualityParam}`;

      // Step 1: Fetch stream
      const res = await fetch(`/api/media/stream/${tmdbId}?${queryParams}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Failed to resolve stream (HTTP ${res.status})`);
      }
      const data = await res.json();
      const streamUrl = data.streamUrl;
      this.currentProvider = data.provider || 'Edge';
      this.currentQuality = data.quality || '1080p';
      this.availableProviders = data.providers || [];
      this.availableQualities = data.allQualities || ['1080p'];

      // Streamo loading stage 2: Stream found, preparing stream
      this.showLoading(
        `Stream Found via ${this.currentProvider} (${this.currentQuality})!`,
        'Preparing video player and audio channels...'
      );

      // Update stat cards
      const statQ = document.getElementById('stat-val-quality');
      const statP = document.getElementById('stat-val-source');
      const pillQ = document.getElementById('btn-player-quality-pill');
      if (statQ) statQ.textContent = this.currentQuality;
      if (statP) statP.textContent = this.currentProvider;
      if (pillQ) pillQ.textContent = this.currentQuality;

      // Update Episodes button visibility
      const episodesBtn = document.getElementById('btn-player-episodes');
      if (episodesBtn) {
        if (type === 'tv') {
          episodesBtn.style.display = 'inline-flex';
          episodesBtn.title = `Switch Season/Episode (Current: S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')})`;
        } else {
          episodesBtn.style.display = 'none';
        }
      }

      // Set currentVideo immediately so drawer and UI have correct context during load
      this.currentVideo = {
        url: '',
        title: title,
        poster: movie.poster || '',
        provider: this.currentProvider || 'Edge',
        subtitlesUrl: null,
        tmdbId: Number(tmdbId),
        type: type,
        season: Number(season),
        episode: Number(episode),
        seriesTitle: movie.seriesTitle || (title.includes(' - ') ? title.split(' - ')[0] : title),
      };

      // Preload series metadata for episode drawer if TV show
      if (type === 'tv') {
        this._loadSeriesSeasonsForDrawer(tmdbId);
      }

      // Step 2: Fetch subtitles catalog
      let proxiedSubtitleUrl = null;
      try {
        const subRes = await fetch(
          `/api/media/subtitles?tmdbId=${tmdbId}&type=${type}&language=English&season=${season}&episode=${episode}`
        );
        if (subRes.ok) {
          const subData = await subRes.json();
          proxiedSubtitleUrl = subData.url;
          this.subtitleTracks = subData.tracks || [];
          if (window.onSubtitlesLoaded) {
            window.onSubtitlesLoaded(this.subtitleTracks, proxiedSubtitleUrl);
          }
          this._renderSubtitlesList();
        }
      } catch (err) {
        console.warn('[PartyPlayer] Subtitles fetch non-fatal error:', err);
      }

      // Step 3: Attach video & subtitles locally
      await this.attachStream(streamUrl, proxiedSubtitleUrl);

      // Step 4: Broadcast WebSocket party state
      const ntpNow = this.getNtpNow();
      this.currentVideo.url = streamUrl;
      this.currentVideo.subtitlesUrl = proxiedSubtitleUrl;

      this.syncState = {
        status: 'PAUS',
        position: 0,
        time: ntpNow,
        started: null,
        paused: 0,
        rate: this.playbackSpeed || 1.0
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
            paused: 0,
            rate: this.playbackSpeed || 1.0
          }
        }
      });

      // Wait until video has loaded metadata/buffered before clearing loader and starting countdown
      await new Promise((resolve) => {
        if (this.video && this.video.readyState >= 1) return resolve();
        const onReady = () => {
          if (typeof this.video?.removeEventListener === 'function') {
            this.video.removeEventListener('loadedmetadata', onReady);
            this.video.removeEventListener('canplay', onReady);
          }
          clearTimeout(readyTimer);
          resolve();
        };
        const readyTimer = setTimeout(onReady, 3500);
        if (typeof this.video?.addEventListener === 'function') {
          this.video.addEventListener('loadedmetadata', onReady, { once: true });
          this.video.addEventListener('canplay', onReady, { once: true });
        } else {
          resolve();
        }
      });

      // Hide loading overlay before countdown starts
      this.hideLoading();

      const startAtSec = Number(movie.startAt || 0);

      if (startAtSec > 0) {
        // Fast transition for quality/provider switching mid-stream
        this.video.currentTime = startAtSec;
        const playNtp = this.getNtpNow();
        const startMs = Math.round(startAtSec * 1000);
        this.syncState.status = 'PLAY';
        this.syncState.position = startMs;
        this.syncState.time = playNtp;
        this.syncState.started = Math.round(playNtp - (startMs / (this.playbackSpeed || 1.0)));
        this.syncState.paused = null;

        this.wsSend({
          type: 'party',
          party: {
            sync: {
              status: 'PLAY',
              position: startMs,
              time: playNtp,
              started: this.syncState.started,
              paused: null,
              rate: this.playbackSpeed || 1.0
            }
          }
        });

        try {
          await this.video.play();
        } catch {
          this._showPlayPrompt();
        }
      } else {
        // Countdown and play
        await this.showCountdown(3);

        // Transition to play
        const playNtp = this.getNtpNow();
        this.syncState.status = 'PLAY';
        this.syncState.position = 0;
        this.syncState.time = playNtp;
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
              paused: null,
              rate: this.playbackSpeed || 1.0
            }
          }
        });

        try {
          await this.video.play();
        } catch (err) {
          console.warn('[PartyPlayer] Autoplay prevented by browser, displaying tap-to-play button:', err);
          this._showPlayPrompt();
        }
      }

    } catch (err) {
      this.hideLoading();
      this.hideCountdown();
      alert(`Could not load stream: ${err.message}`);
      throw err;
    }
  }

  /**
   * Set or switch subtitle track with optional timing offset & party sync
   */
  setSubtitleTrack(url, label = 'English', offsetMs = 0, isRemote = false) {
    this.activeSubtitleUrl = url;
    this.subtitleOffsetMs = Number(offsetMs) || 0;

    if (this.trackEl) {
      this.trackEl.remove();
      this.trackEl = null;
    }

    if (!url) {
      if (!isRemote && this.onTracksChange) {
        this.onTracksChange({ subtitle: null });
      }
      return;
    }

    this.trackEl = document.createElement('track');
    this.trackEl.kind = 'subtitles';
    this.trackEl.label = label;
    this.trackEl.srclang = 'en';
    this.trackEl.src = url;
    this.trackEl.default = true;
    this.video.appendChild(this.trackEl);

    setTimeout(() => {
      if (this.video.textTracks && this.video.textTracks.length > 0) {
        for (let i = 0; i < this.video.textTracks.length; i++) {
          this.video.textTracks[i].mode = 'showing';
        }
        if (this.subtitleOffsetMs !== 0) {
          this.applySubtitleOffset(this.subtitleOffsetMs);
        }
      }
    }, 50);

    if (!isRemote && this.onTracksChange) {
      this.onTracksChange({
        subtitle: {
          url,
          label,
          offsetMs: this.subtitleOffsetMs,
        },
      });
    }
  }

  /**
   * Shift subtitle cues by offset in milliseconds
   */
  applySubtitleOffset(offsetMs) {
    this.subtitleOffsetMs = Number(offsetMs) || 0;
    const offsetSec = this.subtitleOffsetMs / 1000;
    const offsetEl = document.getElementById('subtitles-offset-val');
    if (offsetEl) {
      offsetEl.textContent = `${(offsetSec >= 0 ? '+' : '')}${offsetSec.toFixed(1)}s`;
    }

    const track = this.video.textTracks && this.video.textTracks[0];
    if (track && track.cues) {
      for (let i = 0; i < track.cues.length; i++) {
        const cue = track.cues[i];
        if (cue._origStart === undefined) {
          cue._origStart = cue.startTime;
          cue._origEnd = cue.endTime;
        }
        cue.startTime = Math.max(0, cue._origStart + offsetSec);
        cue.endTime = Math.max(0, cue._origEnd + offsetSec);
      }
    }
  }

  /**
   * Set or switch audio language track
   */
  setAudioTrack(trackId, isRemote = false) {
    if (!this.hls || trackId === undefined) return;
    this.hls.audioTrack = trackId;
    this.selectedAudioTrackId = trackId;

    const track = this.audioTracks.find(t => t.id === trackId);
    const label = track ? (track.name || track.lang || `Track ${trackId + 1}`) : 'Default';

    const cardEl = document.getElementById('stat-val-audio-tracks');
    if (cardEl) cardEl.textContent = label;
    const rowEl = document.getElementById('row-val-audio-tracks');
    if (rowEl) rowEl.textContent = label;

    if (!isRemote && this.onTracksChange && track) {
      this.onTracksChange({
        audio: {
          id: track.id,
          name: track.name || track.lang || 'Default',
          lang: track.lang || '',
        },
      });
    }
  }

  /**
   * Apply synchronized subtitle and audio tracks from party peers
   */
  applyRemoteTracks(tracks) {
    if (!tracks) return;

    // 1. Sync Subtitle track
    if (tracks.subtitle !== undefined) {
      if (tracks.subtitle === null) {
        this.setSubtitleTrack(null, 'Off', 0, true);
      } else if (tracks.subtitle.url && tracks.subtitle.url !== this.activeSubtitleUrl) {
        this.setSubtitleTrack(tracks.subtitle.url, tracks.subtitle.label || 'English', tracks.subtitle.offsetMs || 0, true);
      } else if (tracks.subtitle.offsetMs !== undefined && tracks.subtitle.offsetMs !== this.subtitleOffsetMs) {
        this.applySubtitleOffset(tracks.subtitle.offsetMs);
      }
    }

    // 2. Sync Audio track
    if (tracks.audio && this.hls && this.audioTracks.length > 0) {
      const match = this.audioTracks.find(
        t => t.id === tracks.audio.id || t.lang === tracks.audio.lang || t.name === tracks.audio.name
      );
      if (match && this.hls.audioTrack !== match.id) {
        this.setAudioTrack(match.id, true);
      }
    }
  }

  /**
   * Smart TV Casting & AirPlay Integration (Phase 4)
   */
  initCasting() {
    if (window.WebKitPlaybackTargetAvailabilityEvent) {
      this.video.addEventListener('webkitplaybacktargetavailabilitychanged', (event) => {
        const castBtn = document.getElementById('btn-player-cast');
        if (castBtn) {
          castBtn.style.display = event.availability === 'available' ? 'inline-flex' : '';
        }
      });
    }

    window['__onGCastApiAvailable'] = (isAvailable) => {
      if (isAvailable && window.cast && window.cast.framework) {
        try {
          window.cast.framework.CastContext.getInstance().setOptions({
            receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
            autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
          });
        } catch (e) {
          console.warn('[Cast] Cast context init error:', e);
        }
      }
    };
  }

  toggleCast() {
    // 1. AirPlay on iOS / Apple Devices
    if (this.video.webkitShowPlaybackTargetPicker) {
      this.video.webkitShowPlaybackTargetPicker();
      return;
    }

    // 2. Google Cast Framework (Chromecast, Google TV)
    if (window.cast && window.cast.framework) {
      try {
        const castContext = window.cast.framework.CastContext.getInstance();
        castContext.requestSession().then(
          () => {
            this.isCasting = true;
            this.toggleRemoteMode(true);
          },
          (err) => {
            console.log('[Cast] Request session cancelled:', err);
          }
        );
        return;
      } catch (e) {
        console.warn('[Cast] CastContext error:', e);
      }
    }

    // 3. Fallback: Toggle Smart TV Remote Control Mode
    this.toggleRemoteMode(!this.isRemoteMode);
  }

  toggleRemoteMode(active) {
    this.isRemoteMode = active;
    if (this.container) {
      this.container.classList.toggle('is-remote-mode', active);
    }
    const castBtn = document.getElementById('btn-player-cast');
    if (castBtn) {
      castBtn.classList.toggle('is-active', active);
    }
  }

  /**
   * Attaches video stream URL (HLS .m3u8 or MP4)
   */
  async attachStream(url, subtitlesUrl = null) {
    if (!url) return;
    this.isHlsManifestLoaded = false;

    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    const isHls = url.includes('.m3u8') || url.includes('/hls') || url.includes('type=hls');

    if (isHls && window.Hls && window.Hls.isSupported()) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (!settled) {
            settled = true;
            clearTimeout(safetyTimer);
            resolve();
          }
        };

        // Safety fallback timer: Never allow UI loading screen to remain frozen indefinitely
        const safetyTimer = setTimeout(() => {
          console.warn('[PartyPlayer] attachStream timeout safety triggered (4.5s) — unlocking player overlay');
          finish();
        }, 4500);

        this.hls = new window.Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 90,
          maxBufferLength: 30,
        });

        this.hls.loadSource(url);
        this.hls.attachMedia(this.video);

        this.hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          this.isHlsManifestLoaded = true;
          this._populateAudioTracks(this.hls.audioTracks);
          if (subtitlesUrl) {
            this.setSubtitleTrack(subtitlesUrl);
          }
          // Root cause C fix: Force seek to desiredPosition explicitly before starting playback
          this.syncToPosition(this.getDesiredPositionMs());
          this.startDriftLoop();
          finish();
        });

        this.hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, (event, data) => {
          this._populateAudioTracks(data.audioTracks);
        });

        let errorRetries = 0;
        this.hls.on(window.Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            console.warn('[Hls] Fatal error encountered:', data.type, data.details);
            errorRetries++;

            const isUnrecoverable =
              errorRetries >= 2 ||
              data.details === window.Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
              data.details === window.Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
              data.details === window.Hls.ErrorDetails.KEY_LOAD_ERROR ||
              data.details === window.Hls.ErrorDetails.KEY_LOAD_TIMEOUT ||
              data.details === window.Hls.ErrorDetails.LEVEL_LOAD_ERROR;

            if (isUnrecoverable) {
              console.warn('[Hls] Fatal stream failure, auto-failing over to alternative provider...');
              this.hls.destroy();
              if (this.availableProviders?.length > 1 && this.currentVideo?.tmdbId && !this._isSwitchingProvider) {
                this._isSwitchingProvider = true;
                const otherProviders = this.availableProviders.filter(p => p.name !== this.currentProvider);
                if (otherProviders.length > 0) {
                  const nextP = otherProviders[0].name;
                  console.log(`[PartyPlayer] Auto-switching to fallback provider: ${nextP}`);
                  setTimeout(() => {
                    this._isSwitchingProvider = false;
                    this.loadStream({
                      ...this.currentVideo,
                      preferredProvider: nextP,
                    }).catch(() => {});
                  }, 400);
                }
              }
              finish();
              return;
            }

            switch (data.type) {
              case window.Hls.ErrorTypes.NETWORK_ERROR:
                console.warn('[Hls] Fatal network error encountered, attempting recovery...');
                this.hls.startLoad();
                break;
              case window.Hls.ErrorTypes.MEDIA_ERROR:
                console.warn('[Hls] Fatal media error encountered, recovering media...');
                this.hls.recoverMediaError();
                break;
              default:
                this.hls.destroy();
                finish();
                break;
            }
          }
        });
      });
    } else {
      this.video.src = url;
      if (subtitlesUrl) {
        this.setSubtitleTrack(subtitlesUrl);
      }
      const onNativeReady = () => {
        this.isHlsManifestLoaded = true;
        // Root cause C fix: Force seek to desiredPosition explicitly on native canplay/loadedmetadata
        this.syncToPosition(this.getDesiredPositionMs());
        if (typeof this.video.removeEventListener === 'function') {
          this.video.removeEventListener('loadedmetadata', onNativeReady);
          this.video.removeEventListener('canplay', onNativeReady);
        }
      };
      if (typeof this.video.addEventListener === 'function') {
        this.video.addEventListener('loadedmetadata', onNativeReady, { once: true });
        this.video.addEventListener('canplay', onNativeReady, { once: true });
      } else {
        this.isHlsManifestLoaded = true;
        this.syncToPosition(this.getDesiredPositionMs());
      }
      this.startDriftLoop();
      return Promise.resolve();
    }
  }

  /**
   * Applies incoming remote sync state from WebSocket
   */
  applySync(remoteSync) {
    if (!remoteSync) return;
    this.isRemoteSync.current = true;
    this.ignoreEventsUntil = Date.now() + 1200;

    const ntpNow = this.getNtpNow();
    let isPaused = remoteSync.status === 'PAUS' || (remoteSync.paused !== null && remoteSync.paused !== undefined);
    if (!isPaused && remoteSync.status === 'PLAY') {
      isPaused = false;
    }

    let targetMs = 0;
    if (isPaused || !remoteSync.started) {
      targetMs = remoteSync.paused ?? remoteSync.position ?? 0;
    } else {
      const elapsed = Math.max(0, ntpNow - remoteSync.started);
      targetMs = Math.round(elapsed * (remoteSync.rate ?? 1.0));
    }

    const currentMs = Math.round(this.video.currentTime * 1000);
    const action = getDriftAction(currentMs, targetMs, isPaused);

    // Update debug drift HUD if debug mode is active (?debug=1)
    if (this.isDebugMode) {
      const wrapEl = document.getElementById('hud-debug-wrap');
      const driftEl = document.getElementById('hud-debug-drift');
      const zoneEl = document.getElementById('hud-debug-zone');
      if (wrapEl) wrapEl.style.display = 'inline-flex';
      if (driftEl) driftEl.textContent = `${action.deltaMs > 0 ? '+' : ''}${action.deltaMs}ms`;
      if (zoneEl) zoneEl.textContent = action.zone || 'ZONE 0';
    }

    if (action.type === 'seek') {
      const dur = this.video.duration;
      // Guard against seeking when media is not yet loaded or duration is 0 / NaN
      if (dur && !isNaN(dur) && isFinite(dur) && dur > 0 && this.video.readyState >= 2) {
        const safeTarget = Math.max(0, Math.min(action.targetSec, Math.max(0, dur - 1)));
        if (Math.abs(this.video.currentTime - safeTarget) > 0.5) {
          this.video.currentTime = safeTarget;
        }
      }
    } else if (action.type === 'rate') {
      this.video.playbackRate = action.rate;
    }

    if (isPaused && !this.video.paused) {
      this.video.pause();
    } else if (!isPaused && this.video.paused) {
      this.video.play().catch(() => {});
    }

    this.syncState = { ...remoteSync };

    // Update HUD display
    const driftEl = document.getElementById('hud-drift');
    const rateEl = document.getElementById('hud-rate');
    const pillEl = document.getElementById('hud-pill');
    const pillText = document.getElementById('hud-state-text');

    if (driftEl) driftEl.textContent = `${Math.round(action.deltaMs || 0)}ms`;
    if (rateEl) rateEl.textContent = `${(this.video.playbackRate || 1.0).toFixed(2)}x`;
    if (pillEl && pillText) {
      const absDrift = Math.abs(action.deltaMs || 0);
      if (absDrift < 500) {
        pillEl.className = 'sync-state-pill in_sync';
        pillText.textContent = 'IN SYNC';
      } else if (absDrift < 2500) {
        pillEl.className = 'sync-state-pill drift';
        pillText.textContent = 'DRIFT CORRECTION';
      } else {
        pillEl.className = 'sync-state-pill hard_sync';
        pillText.textContent = 'HARD SYNC';
      }
    }

    setTimeout(() => {
      this.isRemoteSync.current = false;
    }, 400);
  }

  startDriftLoop() {
    if (this.isDriftRunning) return;
    this.isDriftRunning = true;

    const loop = (timestamp) => {
      if (!this.isDriftRunning) return;

      if (timestamp - this.lastDriftCheck >= 1000) {
        this.lastDriftCheck = timestamp;
        this.checkDrift();
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

  checkDrift() {
    // Only check and correct drift when media is active and ready
    if (this.isRemoteSync.current || !this.syncState || !this.isHlsManifestLoaded || this.video.readyState < 2) return;

    const dur = this.video.duration;
    if (!dur || isNaN(dur) || !isFinite(dur) || dur <= 0) return;

    const ntpNow = this.getNtpNow();
    const isPaused = this.syncState.status === 'PAUS' || this.syncState.paused !== null;

    let targetMs = 0;
    if (isPaused || !this.syncState.started) {
      targetMs = this.syncState.paused ?? this.syncState.position ?? 0;
    } else {
      const elapsed = Math.max(0, ntpNow - this.syncState.started);
      targetMs = Math.round(elapsed * (this.syncState.rate ?? 1.0));
    }

    const currentMs = Math.round(this.video.currentTime * 1000);
    const action = getDriftAction(currentMs, targetMs, isPaused);

    // Update debug drift HUD if debug mode is active (?debug=1)
    if (this.isDebugMode) {
      const wrapEl = document.getElementById('hud-debug-wrap');
      const driftEl = document.getElementById('hud-debug-drift');
      const zoneEl = document.getElementById('hud-debug-zone');
      if (wrapEl) wrapEl.style.display = 'inline-flex';
      if (driftEl) driftEl.textContent = `${action.deltaMs > 0 ? '+' : ''}${action.deltaMs}ms`;
      if (zoneEl) zoneEl.textContent = action.zone || 'ZONE 0';
    }

    const now = Date.now();
    const isSeekingCooldown = (now - (this.lastSeekTime || 0)) < 1000;

    if (action.type === 'seek' && !isSeekingCooldown) {
      this.lastSeekTime = now;
      const safeTarget = Math.max(0, Math.min(action.targetSec, Math.max(0, dur - 1)));
      if (Math.abs(this.video.currentTime - safeTarget) > 0.5) {
        this.video.currentTime = safeTarget;
      }
    } else if (action.type === 'rate') {
      this.video.playbackRate = action.rate;
    }
  }

  _bindVideoEvents() {
    this.video.addEventListener('playing', () => {
      this._hidePlayPrompt();
    });

    // onPlay
    this.video.addEventListener('play', () => {
      this._hidePlayPrompt();
      if (this.isRemoteSync.current || Date.now() < this.ignoreEventsUntil) return;
      const ntpNow = this.getNtpNow();
      const currentMs = Math.round(this.video.currentTime * 1000);
      const rate = this.playbackSpeed || this.syncState?.rate || 1.0;

      this.syncState.status = 'PLAY';
      this.syncState.position = currentMs;
      this.syncState.time = ntpNow;
      this.syncState.started = Math.round(ntpNow - (currentMs / rate));
      this.syncState.paused = null;
      this.syncState.rate = rate;

      this.wsSend({
        type: 'party',
        party: {
          sync: {
            status: 'PLAY',
            position: currentMs,
            time: ntpNow,
            started: this.syncState.started,
            paused: null,
            rate: rate
          }
        }
      });
    });

    // onPause
    this.video.addEventListener('pause', () => {
      if (this.isRemoteSync.current || Date.now() < this.ignoreEventsUntil) return;
      const ntpNow = this.getNtpNow();
      const currentMs = Math.round(this.video.currentTime * 1000);
      const rate = this.playbackSpeed || this.syncState?.rate || 1.0;

      this.syncState.status = 'PAUS';
      this.syncState.position = currentMs;
      this.syncState.time = ntpNow;
      this.syncState.paused = currentMs;
      this.syncState.started = null;
      this.syncState.rate = rate;

      this.wsSend({
        type: 'party',
        party: {
          sync: {
            status: 'PAUS',
            position: currentMs,
            time: ntpNow,
            started: null,
            paused: currentMs,
            rate: rate
          }
        }
      });
    });

    // onSeeked
    this.video.addEventListener('seeked', () => {
      if (this.isRemoteSync.current || Date.now() < this.ignoreEventsUntil) return;
      const ntpNow = this.getNtpNow();
      const currentMs = Math.round(this.video.currentTime * 1000);
      const isPaused = this.video.paused;
      const rate = this.playbackSpeed || this.syncState?.rate || 1.0;

      if (isPaused) {
        this.syncState.status = 'PAUS';
        this.syncState.position = currentMs;
        this.syncState.time = ntpNow;
        this.syncState.paused = currentMs;
        this.syncState.started = null;
        this.syncState.rate = rate;

        this.wsSend({
          type: 'party',
          party: {
            sync: {
              status: 'PAUS',
              position: currentMs,
              time: ntpNow,
              started: null,
              paused: currentMs,
              rate: rate
            }
          }
        });
      } else {
        this.syncState.status = 'PLAY';
        this.syncState.position = currentMs;
        this.syncState.time = ntpNow;
        this.syncState.started = Math.round(ntpNow - (currentMs / rate));
        this.syncState.paused = null;
        this.syncState.rate = rate;

        this.wsSend({
          type: 'party',
          party: {
            sync: {
              status: 'PLAY',
              position: currentMs,
              time: ntpNow,
              started: this.syncState.started,
              paused: null,
              rate: rate
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
    if (this.controlsOverlay) this.controlsOverlay.remove();
    if (this.lockOverlay) this.lockOverlay.remove();
    if (this.settingsMenu) this.settingsMenu.remove();
    if (this.febboxModal) this.febboxModal.remove();
  }
}

export default PartyPlayer;

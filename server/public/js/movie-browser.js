// @ts-nocheck
/**
 * StreamSync - Movie Browser Component
 * ES Module: Search, browse, and select movies/TV shows with TMDB metadata.
 */

export class MovieBrowser {
  /**
   * @param {HTMLElement} container
   * @param {(movie: object) => void} onMovieSelect
   * @param {object} options
   */
  constructor(container, onMovieSelect, options = {}) {
    this.container = container;
    this.onMovieSelect = onMovieSelect;
    this.isHost = options.isHost ?? true;
    this.sharedControls = options.sharedControls ?? true;
    this.debounceTimer = null;
    this.currentCategory = 'trending';
    this.movies = [];

    this.injectStyles();
    this.renderShell();
    this.bindEvents();
  }

  injectStyles() {
    if (document.getElementById('streamsync-browser-styles')) return;
    const style = document.createElement('style');
    style.id = 'streamsync-browser-styles';
    style.textContent = `
      .sb-browser {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: #0d0d0d;
        color: #f8fafc;
        font-family: 'Inter', -apple-system, sans-serif;
        overflow: hidden;
      }
      .sb-header {
        padding: 20px 24px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(13, 13, 13, 0.95);
        backdrop-filter: blur(12px);
      }
      .sb-search-wrap {
        position: relative;
        display: flex;
        align-items: center;
      }
      .sb-search-icon {
        position: absolute;
        left: 14px;
        color: #64748b;
        pointer-events: none;
      }
      .sb-search-input {
        width: 100%;
        padding: 12px 16px 12px 42px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 10px;
        color: #fff;
        font-size: 14px;
        outline: none;
        transition: all 0.2s ease;
      }
      .sb-search-input:focus {
        border-color: #3b82f6;
        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25);
        background: rgba(255, 255, 255, 0.09);
      }
      .sb-genres {
        display: flex;
        gap: 8px;
        margin-top: 14px;
        overflow-x: auto;
        padding-bottom: 4px;
      }
      .sb-genres::-webkit-scrollbar { height: 4px; }
      .sb-genres::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.1); border-radius: 2px; }
      .sb-genre-chip {
        padding: 6px 14px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 20px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        transition: all 0.15s ease;
      }
      .sb-genre-chip:hover {
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
      }
      .sb-genre-chip.active {
        background: #3b82f6;
        border-color: #3b82f6;
        color: #fff;
        box-shadow: 0 0 12px rgba(59, 130, 246, 0.4);
      }
      .sb-content {
        flex: 1;
        overflow-y: auto;
        padding: 20px 24px;
      }
      .sb-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 16px;
      }
      .movie-card {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 12px;
        overflow: hidden;
        cursor: pointer;
        transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
        display: flex;
        flex-direction: column;
      }
      .movie-card:hover {
        transform: translateY(-4px);
        border-color: #3b82f6;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5), 0 0 16px rgba(59, 130, 246, 0.2);
      }
      .movie-card img {
        width: 100%;
        aspect-ratio: 2/3;
        object-fit: cover;
        background: #1e293b;
        display: block;
      }
      .movie-info {
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .movie-info .title {
        font-size: 13px;
        font-weight: 600;
        color: #f1f5f9;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .movie-info .meta-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11px;
        color: #94a3b8;
      }
      .movie-info .rating {
        color: #f59e0b;
        font-weight: 600;
      }
      /* Detail Modal */
      .sb-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.88);
        backdrop-filter: blur(14px);
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.25s ease;
      }
      .sb-modal-backdrop.open {
        opacity: 1;
        pointer-events: auto;
      }
      .sb-modal {
        background: #0d1117;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 18px;
        width: 100%;
        max-width: 820px;
        max-height: 90vh;
        overflow-y: auto;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.9);
        transform: scale(0.95);
        transition: transform 0.25s ease;
        position: relative;
      }
      .sb-modal::-webkit-scrollbar {
        width: 6px;
      }
      .sb-modal::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.15);
        border-radius: 3px;
      }
      .sb-modal-backdrop.open .sb-modal {
        transform: scale(1);
      }
      .sb-modal-hero {
        height: 260px;
        position: relative;
        background-size: cover;
        background-position: center 20%;
      }
      .sb-modal-hero::after {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(to top, #0d1117 0%, rgba(13, 17, 23, 0.5) 50%, transparent 100%);
      }
      .sb-modal-close {
        position: absolute;
        top: 16px;
        right: 16px;
        width: 34px;
        height: 34px;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.65);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        z-index: 10;
        font-size: 16px;
        transition: all 0.2s ease;
      }
      .sb-modal-close:hover {
        background: rgba(239, 68, 68, 0.8);
      }
      .sb-modal-body {
        padding: 24px 28px;
        position: relative;
      }
      .sb-modal-header-row {
        display: flex;
        gap: 20px;
        margin-top: -80px;
        position: relative;
        z-index: 5;
        margin-bottom: 20px;
      }
      .sb-modal-poster {
        width: 120px;
        height: 180px;
        border-radius: 10px;
        object-fit: cover;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.8);
        border: 2px solid rgba(255, 255, 255, 0.15);
        flex-shrink: 0;
      }
      .sb-modal-title-col {
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        padding-bottom: 6px;
      }
      .sb-modal-title {
        font-size: 26px;
        font-weight: 800;
        color: #fff;
        letter-spacing: -0.02em;
        line-height: 1.2;
      }
      .sb-modal-meta-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        font-size: 13px;
        color: #94a3b8;
        margin-top: 8px;
        align-items: center;
      }
      .sb-badge-rating {
        background: #f59e0b;
        color: #000;
        font-weight: 700;
        font-size: 11px;
        padding: 2px 7px;
        border-radius: 5px;
      }
      .sb-badge-type {
        background: rgba(99, 102, 241, 0.2);
        color: #818cf8;
        border: 1px solid rgba(99, 102, 241, 0.4);
        font-weight: 600;
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 5px;
        text-transform: uppercase;
      }
      .sb-modal-genres {
        display: flex;
        gap: 6px;
      }
      .sb-modal-genre {
        padding: 2px 8px;
        background: rgba(255, 255, 255, 0.08);
        border-radius: 4px;
        font-size: 11px;
        color: #cbd5e1;
      }
      .sb-modal-overview {
        font-size: 14px;
        line-height: 1.6;
        color: #cbd5e1;
        margin-bottom: 20px;
      }
      .sb-series-tabs {
        display: flex;
        gap: 8px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        padding-bottom: 12px;
        margin-bottom: 16px;
        overflow-x: auto;
      }
      .sb-series-tab {
        padding: 8px 18px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 20px;
        font-size: 13px;
        font-weight: 600;
        color: #94a3b8;
        cursor: pointer;
        white-space: nowrap;
        transition: all 0.15s ease;
      }
      .sb-series-tab:hover {
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
      }
      .sb-series-tab.active {
        background: #3b82f6;
        border-color: #3b82f6;
        color: #fff;
        box-shadow: 0 0 12px rgba(59, 130, 246, 0.4);
      }
      .sb-episodes-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 14px;
        margin-bottom: 20px;
        max-height: 380px;
        overflow-y: auto;
        padding-right: 4px;
      }
      .sb-episodes-grid::-webkit-scrollbar {
        width: 4px;
      }
      .sb-episodes-grid::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.15);
        border-radius: 2px;
      }
      .sb-ep-card {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 10px;
        overflow: hidden;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        transition: all 0.2s ease;
        position: relative;
      }
      .sb-ep-card:hover {
        transform: translateY(-3px);
        border-color: #3b82f6;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.6), 0 0 12px rgba(59, 130, 246, 0.25);
      }
      .sb-ep-card-thumb-wrap {
        position: relative;
        width: 100%;
        aspect-ratio: 16/9;
        background: #1e293b;
        overflow: hidden;
      }
      .sb-ep-card-thumb {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .sb-ep-badge {
        position: absolute;
        top: 6px;
        left: 6px;
        background: rgba(0, 0, 0, 0.75);
        backdrop-filter: blur(4px);
        color: #38bdf8;
        font-size: 11px;
        font-weight: 700;
        padding: 2px 6px;
        border-radius: 4px;
        border: 1px solid rgba(56, 189, 248, 0.3);
      }
      .sb-ep-play-overlay {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity 0.2s ease;
      }
      .sb-ep-card:hover .sb-ep-play-overlay {
        opacity: 1;
      }
      .sb-ep-play-btn {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background: #3b82f6;
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 0 14px rgba(59, 130, 246, 0.8);
      }
      .sb-ep-info {
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: 1;
      }
      .sb-ep-title {
        font-size: 12px;
        font-weight: 600;
        color: #f1f5f9;
        line-height: 1.3;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .sb-ep-meta {
        font-size: 11px;
        color: #94a3b8;
        display: flex;
        justify-content: space-between;
        margin-top: auto;
      }
      .sb-modal-actions {
        display: flex;
        gap: 12px;
        margin-top: 10px;
      }
      .sb-btn-watch {
        flex: 1;
        padding: 14px;
        background: linear-gradient(135deg, #3b82f6, #6366f1);
        border: none;
        border-radius: 10px;
        color: #fff;
        font-weight: 600;
        font-size: 15px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        box-shadow: 0 4px 16px rgba(59, 130, 246, 0.4);
        transition: all 0.15s ease;
      }
      .sb-btn-watch:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 20px rgba(59, 130, 246, 0.6);
      }
      .sb-btn-watch:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none;
      }
      .sb-disabled-tip {
        font-size: 12px;
        color: #ef4444;
        text-align: center;
        margin-top: 8px;
      }
    `;
    document.head.appendChild(style);
  }

  renderShell() {
    this.container.innerHTML = `
      <div class="sb-browser">
        <div class="sb-header">
          <div class="sb-search-wrap">
            <svg class="sb-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input type="text" class="sb-search-input" placeholder="Search movies or TV shows..." autofocus />
          </div>
          <div class="sb-genres">
            <button class="sb-genre-chip active" data-genre="trending">🔥 Trending</button>
            <button class="sb-genre-chip" data-genre="action">Action</button>
            <button class="sb-genre-chip" data-genre="comedy">Comedy</button>
            <button class="sb-genre-chip" data-genre="drama">Drama</button>
            <button class="sb-genre-chip" data-genre="scifi">Sci-Fi</button>
            <button class="sb-genre-chip" data-genre="horror">Horror</button>
            <button class="sb-genre-chip" data-genre="animation">Animation</button>
          </div>
        </div>
        <div class="sb-content">
          <div class="sb-grid" id="sb-grid"></div>
        </div>
      </div>
      <div class="sb-modal-backdrop" id="sb-detail-modal"></div>
    `;
  }

  bindEvents() {
    const input = this.container.querySelector('.sb-search-input');
    input.addEventListener('input', (e) => {
      const q = e.target.value.trim();
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        if (q.length > 0) {
          this.search(q);
        } else {
          this.fetchTrending();
        }
      }, 400);
    });

    const chips = this.container.querySelectorAll('.sb-genre-chip');
    chips.forEach((chip) => {
      chip.addEventListener('click', () => {
        chips.forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        const genre = chip.getAttribute('data-genre');
        if (genre === 'trending') {
          this.fetchTrending();
        } else {
          this.search(genre);
        }
      });
    });

    // Laptop & Trackpad Wheel Scrolling Bridge for .sb-content
    const content = this.container.querySelector('.sb-content');
    if (content) {
      content.addEventListener('wheel', (e) => {
        if (e.deltaY) {
          content.scrollTop += e.deltaY;
        }
      }, { passive: true });
    }
  }

  async init() {
    await this.fetchTrending();
  }

  async fetchTrending() {
    try {
      const res = await fetch('/api/media/trending');
      const data = await res.json();
      this.movies = data || [];
      this.renderGrid(this.movies);
    } catch (err) {
      console.error('[MovieBrowser] Failed to fetch trending:', err);
    }
  }

  async search(query) {
    try {
      const res = await fetch(`/api/media/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      this.movies = data || [];
      this.renderGrid(this.movies);
    } catch (err) {
      console.error('[MovieBrowser] Search failed:', err);
    }
  }

  renderGrid(movies) {
    const grid = this.container.querySelector('#sb-grid');
    if (!movies || movies.length === 0) {
      grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: #64748b; padding: 48px;">No movies found. Try another search.</div>`;
      return;
    }

    grid.innerHTML = movies
      .map(
        (m) => `
        <div class="movie-card" data-tmdb-id="${m.tmdbId}" data-type="${m.type}">
          <img src="${m.poster || 'https://via.placeholder.com/300x450/1e293b/94a3b8?text=No+Poster'}" loading="lazy" alt="${escapeHtml(m.title)}" />
          <div class="movie-info">
            <span class="title">${escapeHtml(m.title)}</span>
            <div class="meta-row">
              <span class="year">${m.year || 'N/A'}</span>
              <span class="rating">⭐ ${m.rating || 'N/A'}</span>
            </div>
          </div>
        </div>
      `
      )
      .join('');

    grid.querySelectorAll('.movie-card').forEach((card) => {
      card.addEventListener('click', () => {
        const id = card.getAttribute('data-tmdb-id');
        const type = card.getAttribute('data-type');
        const item = (movies || []).find((m) => String(m.tmdbId) === String(id));
        this.renderDetail(id, type, item);
      });
    });
  }

  async renderDetail(tmdbId, type, itemFallback = null) {
    const modalBackdrop = this.container.querySelector('#sb-detail-modal');
    modalBackdrop.innerHTML = `
      <div class="sb-modal">
        <div style="padding: 48px; text-align: center; color: #94a3b8;">Loading movie details...</div>
      </div>
    `;
    modalBackdrop.classList.add('open');

    try {
      const base = itemFallback || (this.movies || []).find((m) => String(m.tmdbId) === String(tmdbId)) || {};
      let d = null;
      try {
        const res = await fetch(`/api/media/${type || base.type || 'movie'}/${tmdbId}`);
        if (res.ok) {
          const json = await res.json();
          if (json && !json.error) {
            d = json;
          }
        }
      } catch (fetchErr) {
        console.warn('[MovieBrowser] Detail fetch error:', fetchErr);
      }

      // Merge backend details with baseline card data so titles/posters/tmdbIds are ALWAYS valid
      d = {
        tmdbId: Number(tmdbId),
        type: d?.type || type || base.type || 'movie',
        title: d?.title || base.title || `Media #${tmdbId}`,
        year: d?.year || base.year || '',
        rating: d?.rating || base.rating || 'N/A',
        overview: d?.overview || base.overview || 'Available for synchronized party streaming.',
        poster: d?.poster || base.poster || '',
        backdrop: d?.backdrop || base.backdrop || d?.poster || base.poster || '',
        cast: d?.cast || [],
        runtime: d?.runtime || 0,
        genres: d?.genres || [],
        seasons: d?.seasons || (type === 'tv' ? [{ seasonNumber: 1, name: 'Season 1', episodes: [{ episodeNumber: 1, name: 'Episode 1' }] }] : []),
        seasonsCount: d?.seasonsCount || (d?.seasons?.length || 1),
        episodesCount: d?.episodesCount || 0,
      };

      const canSelect = this.isHost || this.sharedControls;

      const isTv = d.type === 'tv' || (Array.isArray(d.seasons) && d.seasons.length > 0);
      const seasons = Array.isArray(d.seasons) ? d.seasons : [];
      // Default to season 1 if available, otherwise first season
      let selectedSeasonNumber = seasons.find((s) => s.seasonNumber === 1)?.seasonNumber ?? (seasons[0]?.seasonNumber || 1);

      const renderEpisodesHtml = (sNum) => {
        const curSeason = seasons.find((s) => s.seasonNumber === sNum);
        if (!curSeason || !curSeason.episodes || curSeason.episodes.length === 0) {
          return `<div style="grid-column: 1/-1; text-align: center; color: #64748b; padding: 24px;">No episodes listed for this season.</div>`;
        }
        return curSeason.episodes
          .map((ep) => `
            <div class="sb-ep-card" data-season="${sNum}" data-episode="${ep.episodeNumber}">
              <div class="sb-ep-card-thumb-wrap">
                <img class="sb-ep-card-thumb" src="${ep.still || d.backdrop || 'https://via.placeholder.com/320x180/1e293b/94a3b8?text=No+Still'}" loading="lazy" alt="S${sNum}E${ep.episodeNumber}" />
                <span class="sb-ep-badge">E${String(ep.episodeNumber).padStart(2, '0')}</span>
                <div class="sb-ep-play-overlay">
                  <div class="sb-ep-play-btn">▶</div>
                </div>
              </div>
              <div class="sb-ep-info">
                <span class="sb-ep-title" title="${escapeHtml(ep.name)}">${ep.episodeNumber}. ${escapeHtml(ep.name)}</span>
                <div class="sb-ep-meta">
                  <span>${ep.airDate || 'N/A'}</span>
                  <span>${ep.runtime ? `${ep.runtime}m` : '45m'}</span>
                </div>
              </div>
            </div>
          `)
          .join('');
      };

      modalBackdrop.innerHTML = `
        <div class="sb-modal">
          <button class="sb-modal-close" id="sb-modal-close-btn">&times;</button>
          <div class="sb-modal-hero" style="background-image: url('${d.backdrop || d.poster}')"></div>
          <div class="sb-modal-body">
            <div class="sb-modal-header-row">
              <img class="sb-modal-poster" src="${d.poster || 'https://via.placeholder.com/300x450/1e293b/94a3b8?text=No+Poster'}" alt="${escapeHtml(d.title)}" />
              <div class="sb-modal-title-col">
                <h2 class="sb-modal-title">${escapeHtml(d.title)}</h2>
                <div class="sb-modal-meta-row">
                  <span class="sb-badge-type">${isTv ? 'TV Series' : 'Movie'}</span>
                  <span class="sb-badge-rating">⭐ ${d.rating || 'N/A'}</span>
                  <span>📅 ${d.year || 'N/A'}</span>
                  ${d.runtime ? `<span>⏱️ ${d.runtime} min</span>` : ''}
                  ${isTv && d.seasonsCount ? `<span>📦 ${d.seasonsCount} Seasons</span>` : ''}
                  ${isTv && d.episodesCount ? `<span>🎞️ ${d.episodesCount} Episodes</span>` : ''}
                </div>
                <div class="sb-modal-genres" style="margin-top: 8px;">
                  ${(d.genres || []).map((g) => `<span class="sb-modal-genre">${escapeHtml(g)}</span>`).join('')}
                </div>
              </div>
            </div>

            <p class="sb-modal-overview">${escapeHtml(d.overview || 'No synopsis available.')}</p>
            ${d.cast?.length ? `<div style="font-size: 12px; color: #64748b; margin-bottom: 16px;">Starring: ${escapeHtml(d.cast.join(', '))}</div>` : ''}

            ${
              isTv && seasons.length > 0
                ? `
              <div style="font-size: 14px; font-weight: 700; color: #fff; margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between;">
                <span>Select Season & Episode</span>
                <span style="font-size: 12px; font-weight: 500; color: #94a3b8;">Click any episode to start streaming in sync</span>
              </div>
              <div class="sb-series-tabs" id="sb-series-tabs">
                ${seasons
                  .map(
                    (s) => `
                  <button class="sb-series-tab ${s.seasonNumber === selectedSeasonNumber ? 'active' : ''}" data-season-num="${s.seasonNumber}">
                    ${escapeHtml(s.name || `Season ${s.seasonNumber}`)}
                  </button>
                `
                  )
                  .join('')}
              </div>
              <div class="sb-episodes-grid" id="sb-episodes-grid">
                ${renderEpisodesHtml(selectedSeasonNumber)}
              </div>
            `
                : ''
            }

            <div class="sb-modal-actions">
              <button class="sb-btn-watch" id="sb-btn-watch" ${!canSelect ? 'disabled' : ''}>
                <span>🎬 ${isTv ? 'Play S01 E01 (Pilot)' : 'Watch Together'}</span>
              </button>
            </div>
            ${!canSelect ? `<div class="sb-disabled-tip">Only the host can change the media in this party</div>` : ''}
          </div>
        </div>
      `;

      modalBackdrop.querySelector('#sb-modal-close-btn').addEventListener('click', () => {
        modalBackdrop.classList.remove('open');
      });

      // Bind season tab clicks
      if (isTv && seasons.length > 0) {
        const tabsContainer = modalBackdrop.querySelector('#sb-series-tabs');
        const epGrid = modalBackdrop.querySelector('#sb-episodes-grid');

        const bindEpClicks = () => {
          epGrid.querySelectorAll('.sb-ep-card').forEach((card) => {
            card.addEventListener('click', () => {
              if (!canSelect) {
                alert('Only the host can change the episode in this party');
                return;
              }
              const sNum = Number(card.getAttribute('data-season'));
              const epNum = Number(card.getAttribute('data-episode'));
              const curSeason = seasons.find((s) => s.seasonNumber === sNum);
              const curEp = curSeason?.episodes?.find((e) => e.episodeNumber === epNum);

              modalBackdrop.classList.remove('open');
              this.selectMovie({
                ...d,
                type: 'tv',
                season: sNum,
                episode: epNum,
                title: `${d.title} - S${String(sNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}${curEp ? ' - ' + curEp.name : ''}`,
                episodeTitle: curEp?.name || `Episode ${epNum}`,
                poster: curEp?.still || d.poster,
              });
            });
          });
        };

        tabsContainer.querySelectorAll('.sb-series-tab').forEach((tab) => {
          tab.addEventListener('click', () => {
            tabsContainer.querySelectorAll('.sb-series-tab').forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');
            selectedSeasonNumber = Number(tab.getAttribute('data-season-num'));
            epGrid.innerHTML = renderEpisodesHtml(selectedSeasonNumber);
            bindEpClicks();
          });
        });

        bindEpClicks();
      }

      const watchBtn = modalBackdrop.querySelector('#sb-btn-watch');
      if (watchBtn && canSelect) {
        watchBtn.addEventListener('click', () => {
          modalBackdrop.classList.remove('open');
          if (isTv) {
            const firstSeason = seasons[0];
            const firstEp = firstSeason?.episodes?.[0];
            this.selectMovie({
              ...d,
              type: 'tv',
              season: firstSeason?.seasonNumber || 1,
              episode: firstEp?.episodeNumber || 1,
              title: `${d.title} - S01E01${firstEp ? ' - ' + firstEp.name : ''}`,
              episodeTitle: firstEp?.name || 'Episode 1',
            });
          } else {
            this.selectMovie(d);
          }
        });
      }
    } catch (err) {
      modalBackdrop.innerHTML = `
        <div class="sb-modal" style="padding: 24px; text-align: center;">
          <p style="color: #ef4444;">Failed to load details: ${escapeHtml(err.message)}</p>
          <button class="sb-modal-close" onclick="this.closest('.sb-modal-backdrop').classList.remove('open')">&times;</button>
        </div>
      `;
    }
  }

  selectMovie(movie) {
    if (this.onMovieSelect) {
      this.onMovieSelect(movie);
    }
  }

  setPermissions(isHost, sharedControls) {
    this.isHost = isHost;
    this.sharedControls = sharedControls;
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

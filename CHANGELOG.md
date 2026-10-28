# StreamSync Changelog

## [1.2.0] - 2026-10-27

### Added
- **Complete TV Series & Seasons Support (`/api/media/tv/:tmdbId`, `/api/media/tv/:tmdbId/season/:seasonNumber`)**:
  - Live extraction of rich TV series metadata directly from Streamo's App Router RSC payload and JSON-LD schema (seasons count, episode totals, creators, network ratings, high-res posters and backdrops).
  - Dedicated `/api/media/tv/:tmdbId/season/:seasonNumber` endpoint serving full episode collections with episode stills, air dates, runtimes, and synopses.
  - Automatic series slug discovery via Streamo search catalog fallback.

- **Streamo Original Series Detail Modal & Season/Episode Browser (`/js/movie-browser.js`)**:
  - Exact Streamo visual parity: Large cinematic hero backdrop, floating poster card, 'TV SERIES' badge, IMDb/TMDB rating pills, and metadata summary.
  - Interactive Season Tabs: 'Specials', 'Season 1', 'Season 2', etc. with active indicator pill.
  - Responsive Episode Grid: Episode cards displaying episode thumbnails, 'E01' / 'E02' badges, episode titles, release dates, runtimes, and play hover overlays.
  - Direct episode launch: Clicking any episode starts playback for that exact `{ season, episode }` in synchronized watch party mode.

- **In-Player Episode Switcher Drawer (`/js/party-player.js`)**:
  - In-player 'Episodes' button in control bar when streaming any TV series (`type: 'tv'`).
  - Slide-in glassmorphic Episode Drawer from the right without leaving fullscreen/theater playback.
  - Instant Season dropdown switcher and episode cards with active episode indicator.
  - Switching an episode broadcasts the new episode `{ tmdbId, type: 'tv', season, episode, title }` across WebSocket so all peers in the watch party transition seamlessly.

- **Automated Verification**:
  - `server/test/tv.test.js`: Verified 5+ seasons and episode collections for *Breaking Bad* (TMDB `1396`).
  - Full browser subagent validation of series modal, Season 2 switching, Season 1 Episode 2 playback, and in-player episode drawer.

### Added
- **Streamo Live Streaming Pipeline (`/api/media/stream/:tmdbId`)**:
  - Live 3-step resolution: JWT guest-token negotiation (`POST /api/streaming/guest-token`), priority-ladder provider sorting (`relay > zenith > vidrift > wing > hls > aoneroom > torbox > showbox > rd > direct > embed`), and encrypted ref resolution (`GET /api/streaming/resolve`).
  - Real-time Server-Sent Events (SSE) scraper fallback (`GET /api/streaming/scrape-stream`) with 15s timeout guard.
  - Multi-tiered Redis/in-memory TTL cache: 30 minutes for streams (`stream:{tmdbId}:{type}:{season}:{episode}`), 1 hour for searches (`search:{q}:{type}`), and 24 hours for media metadata.
  - VDRK WebVTT subtitle discovery (`/api/media/subtitles`) and secure CORS proxy (`/api/media/subtitles/proxy`) restricted to verified subtitle domains.
  - TMDB Discovery routes (`/api/media/search`, `/api/media/trending`, `/api/media/movie/:tmdbId`, `/api/media/tv/:tmdbId`) with resilient fallback catalog.

- **Web Theater Movie Browser (`/js/movie-browser.js`)**:
  - Dark-theme slide-in panel with `#0d0d0d` background and `#3b82f6` accent matching the theater stage.
  - 400ms debounced instant search with genre chips (Trending, Action, Comedy, Drama, Sci-Fi, Horror, Animation).
  - Responsive movie grid with lazy-loaded poster cards (`loading="lazy"`).
  - Detail inspection modal displaying high-res backdrop, genre tags, overview, and cast members.

- **Synchronized Party Player (`/js/party-player.js`)**:
  - Integrated HLS adaptive bitrate streaming via Hls.js (`v1.5.13`) with native MP4/HLS fallback.
  - Automatic WebVTT `<track>` mounting via subtitle proxy.
  - Synchronized party state broadcast (`status: "PAUS" / "PLAY"`, `time`, `position`, `started`, `paused`).
  - Seamless 3-2-1 synchronized party countdown overlay before playback kickoff.
  - Dual-threshold drift engine control loop running every 500ms on `requestAnimationFrame` with pitch-preservation (`video.preservesPitch = true`).
  - `isRemoteSync = { current: false }` ref guard preventing echo loops during remote seek/sync.
  - Synchronized host browsing state (`browsing: boolean`) triggering guest waiting overlays.
  - Host vs. Guest control enforcement based on `shared_controls` room configuration.

- **Comprehensive Automated Test Suite**:
  - `server/test/stream.test.js`: Verified Streamo token + resolve flow, provider sorting, SSE scraper fallback, subtitle proxy CORS headers, and TMDB schema normalization.
  - `server/test/browser.test.js`: Verified debounced search querying and DOM card rendering with `data-tmdb-id`.
  - `server/test/player.test.js`: Verified `isRemoteSync` echo-prevention and sub-150ms host/guest position alignment.
  - `test/dual_device_e2e.test.js`: 100% pass across all 6 live dual-device synchronization phases.

/**
 * StreamSync - Media & Streaming Route Plugin
 * Integrates the complete reverse-engineered Streamo streaming pipeline,
 * TMDB metadata discovery, VDRK WebVTT subtitle proxying, and SSE fallback scraping.
 */

import { cache } from '../core/cache.js';

const PRIORITY = {
  relay: 0,
  zenith: 1,
  vidrift: 2,
  wing: 3,
  hls: 4,
  aoneroom: 5,
  torbox: 6,
  showbox: 7,
  rd: 8,
  direct: 9,
  embed: 10,
};

const STREAMO_REFERER = process.env.STREAMO_REFERER || 'https://streamo.st/';
const STREAMO_BASE = 'https://streamo.st';
const STREAM_CACHE_TTL = (Number(process.env.STREAM_CACHE_TTL_MINUTES) || 30) * 60;
const SEARCH_CACHE_TTL = (Number(process.env.SEARCH_CACHE_TTL_HOURS) || 1) * 3600;
const TMDB_KEY = process.env.TMDB_API_KEY || '';

// Fallback catalog when TMDB API is unreachable or key is not provided
const FALLBACK_MOVIES = [
  {
    tmdbId: 27205,
    type: 'movie',
    title: 'Inception',
    year: '2010',
    poster: 'https://image.tmdb.org/t/p/w300/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg',
    rating: 8.4,
    overview: 'Cobb, a skilled thief who commits corporate espionage by infiltrating the subconscious of his targets is offered a chance to regain his old life.',
  },
  {
    tmdbId: 157336,
    type: 'movie',
    title: 'Interstellar',
    year: '2014',
    poster: 'https://image.tmdb.org/t/p/w300/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/xJHokMbljvjADYdit5fK5VQsXEG.jpg',
    rating: 8.4,
    overview: 'The adventures of a group of explorers who make use of a newly discovered wormhole to surpass the limitations on human space travel.',
  },
  {
    tmdbId: 299534,
    type: 'movie',
    title: 'Avengers: Endgame',
    year: '2019',
    poster: 'https://image.tmdb.org/t/p/w300/or06FN3Dka5tukK1e9sl16pB3iy.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/7RyHsO4yDXtBv1zUU3mTpHeQ0d5.jpg',
    rating: 8.3,
    overview: 'After the devastating events of Avengers: Infinity War, the universe is in ruins due to the efforts of the Mad Titan, Thanos.',
  },
  {
    tmdbId: 1153576,
    type: 'movie',
    title: 'Street Fighter',
    year: '2026',
    poster: 'https://image.tmdb.org/t/p/w300/wxiBsKFEOOFK8eQStWOykNORlXY.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/wxiBsKFEOOFK8eQStWOykNORlXY.jpg',
    rating: 7.8,
    overview: 'Live-action feature film adaptation of the Capcom video game franchise.',
  }
];

/**
 * Server-Sent Events Fallback Scraper
 */
async function sseScraperFallback(tmdbId, type, stoken = '') {
  return new Promise((resolve, reject) => {
    const url = `${STREAMO_BASE}/api/streaming/scrape-stream?tmdbId=${tmdbId}&type=${type}`;
    const timer = setTimeout(() => reject(new Error('SSE stream timeout after 15s')), 15000);

    fetch(url, {
      headers: {
        'Accept': 'text/event-stream',
        'Referer': STREAMO_REFERER,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    })
      .then(async (res) => {
        if (!res.ok) {
          clearTimeout(timer);
          return reject(new Error(`SSE request failed with status ${res.status}`));
        }

        const reader = res.body?.getReader();
        if (!reader) {
          clearTimeout(timer);
          return reject(new Error('ReadableStream reader not available'));
        }

        let buffer = '';
        const pump = () =>
          reader.read().then(({ done, value }) => {
            if (done) {
              clearTimeout(timer);
              return reject(new Error('SSE stream ended with no sources'));
            }
            buffer += new TextDecoder().decode(value);
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // retain incomplete chunk

            for (const line of lines) {
              if (line.startsWith('data:')) {
                try {
                  const payload = JSON.parse(line.slice(5).trim());
                  if (payload.sources && payload.sources.length > 0) {
                    clearTimeout(timer);
                    reader.cancel().catch(() => {});
                    return resolve(payload.sources[0]);
                  }
                } catch {}
              }
            }
            pump();
          });

        pump().catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Resolves live stream URL using the 3-step Streamo pipeline + SSE fallback
 */
async function resolveStream(tmdbId, type = 'movie', season = 1, episode = 1) {
  let fallbackUsed = false;
  let stoken = '';
  let providerName = 'Nova';
  let qualityLabel = '1080p';
  let refToResolve = null;

  try {
    // Step 1: Request guest token from Streamo
    const tokenRes = await fetch(`${STREAMO_BASE}/api/streaming/guest-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Referer': STREAMO_REFERER,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify({
        tmdbId: Number(tmdbId),
        type,
        ...(type === 'tv' && { season: Number(season), episode: Number(episode) }),
      }),
    });

    if (tokenRes.ok) {
      const json = await tokenRes.json();
      const tokenData = json?.data;
      if (tokenData?.token) {
        stoken = tokenData.token;
        const providers = tokenData.providers || [];
        providers.sort((a, b) => (PRIORITY[a.kind] ?? 99) - (PRIORITY[b.kind] ?? 99));

        const best = providers[0];
        if (best) {
          providerName = best.name || best.slug || 'Nova';
          refToResolve =
            best.allQualities?.find((q) => q.quality === '1080p')?.url ||
            best.allQualities?.[0]?.url ||
            best.url;
          qualityLabel = best.allQualities?.[0]?.quality || '1080p';
        }
      }
    }
  } catch (err) {
    console.warn('[Streamo] Primary guest-token request error:', err.message);
  }

  // Fallback to SSE scraper if primary providers were missing
  if (!refToResolve) {
    try {
      console.log(`[Streamo] Primary ref missing for TMDB ${tmdbId}, triggering SSE scraper fallback...`);
      const scraped = await sseScraperFallback(tmdbId, type, stoken);
      if (scraped && scraped.url) {
        refToResolve = scraped.url;
        providerName = scraped.provider || 'Ember';
        qualityLabel = scraped.quality || '720p';
        fallbackUsed = true;
      }
    } catch (sseErr) {
      console.warn('[Streamo] SSE fallback failed:', sseErr.message);
    }
  }

  if (!refToResolve) {
    throw new Error('Unable to resolve any streaming providers for this media');
  }

  // Step 2: Resolve encrypted ref token to proxied stream URL
  let streamPath = '';
  if (refToResolve.startsWith('http://') || refToResolve.startsWith('https://') || refToResolve.startsWith('/')) {
    streamPath = refToResolve;
  } else {
    const resolveUrl = `${STREAMO_BASE}/api/streaming/resolve?ref=${encodeURIComponent(refToResolve)}${
      stoken ? `&stoken=${encodeURIComponent(stoken)}` : ''
    }`;
    const resolveRes = await fetch(resolveUrl, {
      headers: {
        'Referer': STREAMO_REFERER,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!resolveRes.ok) {
      throw new Error(`Stream resolve failed with HTTP ${resolveRes.status}`);
    }

    const resolveData = await resolveRes.json();
    if (!resolveData.url) {
      throw new Error('Stream resolve response missing destination URL');
    }
    streamPath = resolveData.url;
  }

  const finalStreamUrl = streamPath.startsWith('http')
    ? streamPath
    : `${STREAMO_BASE}${streamPath}`;

  const subtitlesUrl = `/api/media/subtitles?tmdbId=${tmdbId}&type=${type}&language=English&season=${season}&episode=${episode}`;

  return {
    streamUrl: finalStreamUrl,
    subtitlesUrl,
    provider: providerName,
    quality: qualityLabel,
    fallback: fallbackUsed,
  };
}

/**
 * Fastify plugin for media routes
 */
export default async function mediaRoutes(fastify) {
  // ── GET /api/media/search ───────────────────────────────────────────────
  fastify.get('/search', async (req, reply) => {
    const { q, type = 'movie' } = req.query;
    if (!q || typeof q !== 'string') {
      return reply.code(400).send({ error: 'Query parameter q is required' });
    }

    const cacheKey = `search:${q.trim().toLowerCase()}:${type}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return reply.header('X-Cache', 'HIT').send(cached);
    }

    let results = [];

    if (TMDB_KEY && TMDB_KEY !== 'your_tmdb_key_here') {
      try {
        const tmdbUrl = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(
          q
        )}&api_key=${TMDB_KEY}&include_adult=false`;
        const res = await fetch(tmdbUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });

        if (res.ok) {
          const data = await res.json();
          results = (data.results || [])
            .filter((item) => item.media_type === 'movie' || item.media_type === 'tv')
            .map((item) => ({
              tmdbId: item.id,
              type: item.media_type === 'tv' ? 'tv' : 'movie',
              title: item.title || item.name || '',
              year: (item.release_date || item.first_air_date || '').slice(0, 4),
              poster: item.poster_path ? `https://image.tmdb.org/t/p/w300${item.poster_path}` : '',
              backdrop: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : '',
              rating: item.vote_average ? Number(item.vote_average.toFixed(1)) : 0,
              overview: item.overview || '',
            }));
        }
      } catch (err) {
        console.warn('[TMDB Search] Upstream search error:', err.message);
      }
    }

    // Fallback search match if TMDB key is empty or failed
    if (!results.length) {
      const queryLower = q.toLowerCase();
      results = FALLBACK_MOVIES.filter(
        (m) =>
          m.title.toLowerCase().includes(queryLower) ||
          m.overview.toLowerCase().includes(queryLower)
      );
    }

    await cache.set(cacheKey, results, SEARCH_CACHE_TTL);
    return reply.header('X-Cache', 'MISS').send(results);
  });

  // ── GET /api/media/trending ─────────────────────────────────────────────
  fastify.get('/trending', async (req, reply) => {
    const cacheKey = 'trending:all:week';
    const cached = await cache.get(cacheKey);
    if (cached) {
      return reply.header('X-Cache', 'HIT').send(cached);
    }

    let results = [];

    if (TMDB_KEY && TMDB_KEY !== 'your_tmdb_key_here') {
      try {
        const tmdbUrl = `https://api.themoviedb.org/3/trending/all/week?api_key=${TMDB_KEY}`;
        const res = await fetch(tmdbUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });

        if (res.ok) {
          const data = await res.json();
          results = (data.results || [])
            .filter((item) => item.media_type === 'movie' || item.media_type === 'tv')
            .map((item) => ({
              tmdbId: item.id,
              type: item.media_type === 'tv' ? 'tv' : 'movie',
              title: item.title || item.name || '',
              year: (item.release_date || item.first_air_date || '').slice(0, 4),
              poster: item.poster_path ? `https://image.tmdb.org/t/p/w300${item.poster_path}` : '',
              backdrop: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : '',
              rating: item.vote_average ? Number(item.vote_average.toFixed(1)) : 0,
              overview: item.overview || '',
            }));
        }
      } catch (err) {
        console.warn('[TMDB Trending] Upstream trending error:', err.message);
      }
    }

    if (!results.length) {
      results = FALLBACK_MOVIES;
    }

    await cache.set(cacheKey, results, 6 * 3600);
    return reply.header('X-Cache', 'MISS').send(results);
  });

  // ── GET /api/media/stream/:tmdbId ───────────────────────────────────────
  fastify.get('/stream/:tmdbId', async (req, reply) => {
    const { tmdbId } = req.params;
    const { type = 'movie', season = 1, episode = 1 } = req.query;

    if (!tmdbId) {
      return reply.code(400).send({ error: 'tmdbId parameter is required' });
    }

    const cacheKey = `stream:${tmdbId}:${type}:${season}:${episode}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return reply.header('X-Cache', 'HIT').send(cached);
    }

    try {
      const streamData = await resolveStream(tmdbId, type, season, episode);
      await cache.set(cacheKey, streamData, STREAM_CACHE_TTL);
      return reply.header('X-Cache', 'MISS').send(streamData);
    } catch (err) {
      req.log.error(err, `Failed to resolve stream for tmdbId ${tmdbId}`);
      return reply.code(502).send({
        error: 'Failed to resolve stream from providers',
        message: err.message,
      });
    }
  });

  // ── GET /api/media/subtitles ────────────────────────────────────────────
  fastify.get('/subtitles', async (req, reply) => {
    const { tmdbId, type = 'movie', language = 'English', season = 1, episode = 1 } = req.query;

    if (!tmdbId) {
      return reply.code(400).send({ error: 'tmdbId is required' });
    }

    const rawVttUrl =
      type === 'tv'
        ? `https://cache.vdrk.site/v1/vtt/tv/${tmdbId}/${season}/${episode}/${encodeURIComponent(language)}.vtt`
        : `https://cache.vdrk.site/v1/vtt/movie/${tmdbId}/${encodeURIComponent(language)}.vtt`;

    const proxiedUrl = `/api/media/subtitles/proxy?url=${encodeURIComponent(rawVttUrl)}`;

    return reply.send({
      url: proxiedUrl,
      rawUrl: rawVttUrl,
      language,
      source: 'vdrk',
    });
  });

  // ── GET /api/media/subtitles/proxy ──────────────────────────────────────
  fastify.get('/subtitles/proxy', async (req, reply) => {
    const { url } = req.query;
    if (!url || typeof url !== 'string') {
      return reply.code(400).send({ error: 'url query parameter is required' });
    }

    // Security validation: Only allow trusted subtitle domains
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reply.code(400).send({ error: 'Invalid URL format' });
    }

    const ALLOWED_HOSTS = ['cache.vdrk.site', 'dl.subdl.com', 'localhost', '127.0.0.1'];
    const isAllowed = ALLOWED_HOSTS.some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
    );

    if (!isAllowed) {
      return reply.code(403).send({ error: 'Forbidden subtitle host domain' });
    }

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      if (!res.ok) {
        return reply.code(res.status).send(`WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\n[Subtitles unavailable for this track]`);
      }

      let text = await res.text();
      // Strip any UTF-8 BOM
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }

      return reply
        .header('Content-Type', 'text/vtt; charset=utf-8')
        .header('Access-Control-Allow-Origin', '*')
        .send(text);
    } catch (err) {
      return reply
        .header('Content-Type', 'text/vtt; charset=utf-8')
        .header('Access-Control-Allow-Origin', '*')
        .send(`WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\n[Subtitles connection error]`);
    }
  });

  // ── GET /api/media/movie/:tmdbId & /api/media/tv/:tmdbId ─────────────────
  const handleDetail = async (req, reply, type) => {
    const { tmdbId } = req.params;
    const cacheKey = `detail:${type}:${tmdbId}`;
    const cached = await cache.get(cacheKey);
    if (cached) return reply.send(cached);

    if (TMDB_KEY && TMDB_KEY !== 'your_tmdb_key_here') {
      try {
        const url = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_KEY}&append_to_response=credits,videos`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (res.ok) {
          const d = await res.json();
          const detail = {
            tmdbId: d.id,
            type,
            title: d.title || d.name || '',
            year: (d.release_date || d.first_air_date || '').slice(0, 4),
            runtime: d.runtime || (d.episode_run_time ? d.episode_run_time[0] : 0),
            genres: (d.genres || []).map((g) => g.name),
            rating: d.vote_average ? Number(d.vote_average.toFixed(1)) : 0,
            overview: d.overview || '',
            poster: d.poster_path ? `https://image.tmdb.org/t/p/w300${d.poster_path}` : '',
            backdrop: d.backdrop_path ? `https://image.tmdb.org/t/p/original${d.backdrop_path}` : '',
            cast: (d.credits?.cast || []).slice(0, 5).map((c) => c.name),
            trailerKey: d.videos?.results?.find((v) => v.type === 'Trailer')?.key || null,
          };
          await cache.set(cacheKey, detail, 24 * 3600);
          return reply.send(detail);
        }
      } catch {}
    }

    const fallback = FALLBACK_MOVIES.find((m) => m.tmdbId === Number(tmdbId));
    if (fallback) {
      return reply.send({
        ...fallback,
        runtime: 148,
        genres: ['Action', 'Sci-Fi', 'Adventure'],
        cast: ['Leonardo DiCaprio', 'Joseph Gordon-Levitt', 'Elliot Page'],
        trailerKey: 'YoHD9XEInc0',
      });
    }

    return reply.code(404).send({ error: 'Media details not found' });
  };

  fastify.get('/movie/:tmdbId', (req, reply) => handleDetail(req, reply, 'movie'));
  fastify.get('/tv/:tmdbId', (req, reply) => handleDetail(req, reply, 'tv'));
}

export { mediaRoutes };


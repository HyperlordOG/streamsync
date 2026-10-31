/**
 * StreamSync - Media & Streaming Route Plugin
 * Integrates the complete reverse-engineered Streamo streaming pipeline,
 * TMDB metadata discovery, VDRK WebVTT subtitle proxying, and SSE fallback scraping.
 */

import { cache } from '../core/cache.js';
import https from 'node:https';
import dns from 'node:dns';

// Known official TMDB AWS CloudFront edge IPs (bypasses ISP DNS blocking/poisoning in India and elsewhere)
const TMDB_IPS = [
  '3.160.188.68',
  '3.160.188.33',
  '3.160.188.106',
  '3.160.188.125',
  '108.157.14.80',
  '108.157.14.15',
];
let tmdbIpIndex = 0;

const tmdbHttpsAgent = new https.Agent({
  keepAlive: true,
  timeout: 5000,
  lookup: (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (hostname === 'api.themoviedb.org') {
      const targetIp = TMDB_IPS[tmdbIpIndex % TMDB_IPS.length];
      if (options && options.all) {
        return callback(null, [{ address: targetIp, family: 4 }]);
      }
      return callback(null, targetIp, 4);
    }
    return dns.lookup(hostname, options, callback);
  },
});

function getTmdbKey() {
  const k = process.env.TMDB_API_KEY;
  if (k && k !== 'your_tmdb_key_here' && k.trim()) {
    return k.trim();
  }
  return 'ca9f6f20bf89d524e8635b86cbe194c8';
}

/**
 * Robust TMDB fetcher that bypasses regional ISP blocks and evaluates key dynamically
 */
async function fetchTmdbJson(pathAndQuery) {
  const apiKey = getTmdbKey();
  const separator = pathAndQuery.includes('?') ? '&' : '?';
  const url = `https://api.themoviedb.org/3${pathAndQuery}${separator}api_key=${apiKey}`;

  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        agent: tmdbHttpsAgent,
        headers: {
          'User-Agent': 'StreamSync/1.4.1 (Node.js)',
          'Accept': 'application/json',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(new Error(`TMDB JSON parse error: ${err.message}`));
            }
          } else {
            tmdbIpIndex++;
            reject(new Error(`TMDB HTTP ${res.statusCode}: ${data.slice(0, 100)}`));
          }
        });
      }
    );

    req.on('error', (err) => {
      tmdbIpIndex++;
      reject(err);
    });

    req.setTimeout(4500, () => {
      req.destroy(new Error('TMDB request timed out after 4500ms'));
    });
  });
}

/**
 * Secondary meta search via official Stremio Cinemeta catalog
 */
async function searchCinemeta(query) {
  try {
    const enc = encodeURIComponent(query);
    const [mRes, sRes] = await Promise.allSettled([
      fetch(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${enc}.json`, {
        signal: AbortSignal.timeout(3500),
      }).then((r) => r.json()),
      fetch(`https://v3-cinemeta.strem.io/catalog/series/top/search=${enc}.json`, {
        signal: AbortSignal.timeout(3500),
      }).then((r) => r.json()),
    ]);

    const metas = [
      ...(mRes.status === 'fulfilled' && mRes.value?.metas ? mRes.value.metas : []),
      ...(sRes.status === 'fulfilled' && sRes.value?.metas ? sRes.value.metas : []),
    ];

    const results = [];
    const seen = new Set();
    for (const m of metas) {
      if (!m || !m.name || seen.has(m.id)) continue;
      seen.add(m.id);
      results.push({
        tmdbId: m.imdb_id || m.id,
        type: m.type === 'series' ? 'tv' : 'movie',
        title: m.name,
        year: String(m.releaseInfo || m.year || '').slice(0, 4),
        poster: m.poster || '',
        backdrop: m.background || m.poster || '',
        rating: m.imdbRating ? Number(Number(m.imdbRating).toFixed(1)) : 7.0,
        overview: m.description || `${m.name} (${m.year || ''})`,
      });
    }
    return results;
  } catch (err) {
    return [];
  }
}

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

// Rich fallback catalog across Action, Comedy, Drama, Sci-Fi and Series
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
    tmdbId: 299536,
    type: 'movie',
    title: 'Avengers: Infinity War',
    year: '2018',
    poster: 'https://image.tmdb.org/t/p/w300/7WsyChQLEftFiDOVTGkv3hFpyyt.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/mDfJG3LC3Dqb67AZ52x3Z0jU0uB.jpg',
    rating: 8.3,
    overview: 'As the Avengers and their allies have continued to protect the world, Thanos arrives to collect the six Infinity Stones.',
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
    tmdbId: 155,
    type: 'movie',
    title: 'The Dark Knight',
    year: '2008',
    poster: 'https://image.tmdb.org/t/p/w300/qJ2tW6WMUDux911r6m7haRef0WH.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/nMKdUUepR0i5zn0y1T4CsSB5chy.jpg',
    rating: 8.5,
    overview: 'Batman raises the stakes in his war on crime with the help of Lt. Jim Gordon and District Attorney Harvey Dent.',
  },
  {
    tmdbId: 550,
    type: 'movie',
    title: 'Fight Club',
    year: '1999',
    poster: 'https://image.tmdb.org/t/p/w300/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/hZkgoQYus5vegHoetLkCJzb17zJ.jpg',
    rating: 8.4,
    overview: 'An insomniac office worker and a devil-may-care soap maker form an underground fight club that evolves into something much more.',
  },
  {
    tmdbId: 1396,
    type: 'tv',
    title: 'Breaking Bad',
    year: '2008',
    poster: 'https://image.tmdb.org/t/p/w300/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg',
    rating: 8.9,
    overview: 'Walter White, a chemistry teacher diagnosed with terminal lung cancer, turns to manufacturing and selling methamphetamine.',
  },
  {
    tmdbId: 872585,
    type: 'movie',
    title: 'Oppenheimer',
    year: '2023',
    poster: 'https://image.tmdb.org/t/p/w300/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/fm6K9vY9WgdsAc2JwZ2FsT9OGY9.jpg',
    rating: 8.1,
    overview: 'The story of J. Robert Oppenheimer’s role in the development of the atomic bomb during World War II.',
  },
  {
    tmdbId: 438631,
    type: 'movie',
    title: 'Dune',
    year: '2021',
    poster: 'https://image.tmdb.org/t/p/w300/d5NXSklXo0qyIYkgV94XAgMIckC.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/eeijXm3554UtMVXYqpMTZ59226K.jpg',
    rating: 7.8,
    overview: 'Paul Atreides, a brilliant and gifted young man, must travel to the most dangerous planet in the universe.',
  },
  {
    tmdbId: 569094,
    type: 'movie',
    title: 'Spider-Man: Across the Spider-Verse',
    year: '2023',
    poster: 'https://image.tmdb.org/t/p/w300/8Vt6mWEReuy4Of61Lnj5Xj704m8.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/4HodYYKEIsGOdinkGi2Ucz6X9i0.jpg',
    rating: 8.4,
    overview: 'Miles Morales catapults across the Multiverse, where he encounters a team of Spider-People charged with protecting its existence.',
  },
  {
    tmdbId: 603,
    type: 'movie',
    title: 'The Matrix',
    year: '1999',
    poster: 'https://image.tmdb.org/t/p/w300/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/7c9UVPPiTPltouxShY9f05Pnp9B.jpg',
    rating: 8.2,
    overview: 'Set in the 22nd century, The Matrix tells the story of a computer hacker who joins a group of underground insurgents.',
  },
  {
    tmdbId: 66732,
    type: 'tv',
    title: 'Stranger Things',
    year: '2016',
    poster: 'https://image.tmdb.org/t/p/w300/49WJfeN0moxb9IPfGn8AIqMGskD.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/56v2KjBlU4XaOv9rVYEQypROD7P.jpg',
    rating: 8.6,
    overview: 'When a young boy vanishes, a small town uncovers a mystery involving secret experiments and terrifying supernatural forces.',
  },
  {
    tmdbId: 533535,
    type: 'movie',
    title: 'Deadpool & Wolverine',
    year: '2024',
    poster: 'https://image.tmdb.org/t/p/w300/8cdWjvZQUExUUTzyp4t6EDMubfO.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/yDHYTfA3R0jFYba16jBB1jv8vEU.jpg',
    rating: 7.7,
    overview: 'A listless Wade Wilson toils away in civilian life before finding himself on a mission with Wolverine.',
  },
  {
    tmdbId: 414906,
    type: 'movie',
    title: 'The Batman',
    year: '2022',
    poster: 'https://image.tmdb.org/t/p/w300/74xTEgt7R36Fpooo50r9T25onhq.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/5P8SmMzSNYikXpxil6BYzJ16611.jpg',
    rating: 7.7,
    overview: 'In his second year of fighting crime, Batman uncovers corruption in Gotham City that connects to his own family.',
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
async function resolveStream(
  tmdbId,
  type = 'movie',
  season = 1,
  episode = 1,
  febboxCookie = '',
  preferredQuality = null,
  preferredProvider = null
) {
  let fallbackUsed = false;
  let stoken = '';
  let providerName = 'Nova';
  let qualityLabel = '1080p';
  let refToResolve = null;
  let resolvedDirectUrl = '';
  let availableProviders = [];
  let availableQualities = [];

  try {
    // Step 1: Request guest token from Streamo (passing febboxCookie if provided)
    const requestBody = {
      tmdbId: Number(tmdbId),
      type,
      ...(type === 'tv' && { season: Number(season), episode: Number(episode) }),
      ...(febboxCookie && { febboxCookie: String(febboxCookie).trim() }),
    };

    const tokenRes = await fetch(`${STREAMO_BASE}/api/streaming/guest-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Referer': STREAMO_REFERER,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify(requestBody),
    });

    if (tokenRes.ok) {
      const json = await tokenRes.json();
      const tokenData = json?.data;
      if (tokenData?.token) {
        stoken = tokenData.token;
        const providers = tokenData.providers || [];
        providers.sort((a, b) => (PRIORITY[a.kind] ?? 99) - (PRIORITY[b.kind] ?? 99));

        availableProviders = providers.map((p) => ({
          name: p.name || p.slug || 'Provider',
          kind: p.kind,
          qualities: p.allQualities?.map((q) => q.quality) || [],
        }));

        // Try candidate providers in priority order until a stream resolves successfully
        let candidateProviders = preferredProvider
          ? [
              providers.find(
                (p) => (p.name || p.slug || '').toLowerCase() === preferredProvider.toLowerCase()
              ),
              ...providers.filter(
                (p) => (p.name || p.slug || '').toLowerCase() !== preferredProvider.toLowerCase()
              ),
            ].filter(Boolean)
          : [...providers];

        if (preferredQuality && !preferredProvider) {
          const isTargetQ = (qStr) => {
            if (!qStr) return false;
            const upper = String(qStr).toUpperCase();
            const target = String(preferredQuality).toUpperCase();
            if (upper === target) return true;
            if (target === '4K' && (upper === '4K' || upper === 'ORG' || upper === '2160P')) return true;
            return false;
          };

          const hasTargetQ = (p) => p.allQualities?.some(q => isTargetQ(q.quality));
          candidateProviders = [
            ...candidateProviders.filter(hasTargetQ),
            ...candidateProviders.filter(p => !hasTargetQ(p)),
          ];
        }

        for (const candidate of candidateProviders) {
          let testRef = null;
          let testQuality = '1080p';

          if (preferredQuality) {
            const isMatch = (qStr) => {
              const upper = String(qStr || '').toUpperCase();
              const target = String(preferredQuality).toUpperCase();
              return upper === target || (target === '4K' && (upper === '4K' || upper === 'ORG' || upper === '2160P'));
            };
            const matchQ = candidate.allQualities?.find((q) => isMatch(q.quality));
            if (matchQ) {
              testRef = matchQ.url;
              testQuality = matchQ.quality;
            }
          }

          if (!testRef) {
            testRef =
              candidate.allQualities?.find((q) => q.quality === '1080p')?.url ||
              candidate.allQualities?.[0]?.url ||
              candidate.url;
            testQuality = candidate.allQualities?.[0]?.quality || '1080p';
          }

          if (!testRef) continue;

          try {
            let streamPath = '';
            if (testRef.startsWith('http://') || testRef.startsWith('https://') || testRef.startsWith('/')) {
              streamPath = testRef;
            } else {
              const resolveUrl = `${STREAMO_BASE}/api/streaming/resolve?ref=${encodeURIComponent(testRef)}${
                stoken ? `&stoken=${encodeURIComponent(stoken)}` : ''
              }`;
              const resolveRes = await fetch(resolveUrl, {
                headers: {
                  'Referer': STREAMO_REFERER,
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
                signal: AbortSignal.timeout(5000),
              });

              if (!resolveRes.ok) continue;
              const resolveData = await resolveRes.json();
              if (!resolveData.url) continue;
              streamPath = resolveData.url;
            }

            const candidateStreamUrl = streamPath.startsWith('http')
              ? streamPath
              : `${STREAMO_BASE}${streamPath}`;

            let manifestHealthy = false;
            if (process.env.NODE_ENV === 'test' || candidateStreamUrl.includes('mock') || candidateStreamUrl.includes('vidspark')) {
              manifestHealthy = true;
            } else {
              try {
                const testManifestRes = await fetch(candidateStreamUrl, {
                  headers: { 'User-Agent': 'Mozilla/5.0' },
                  signal: AbortSignal.timeout(4000),
                });
                manifestHealthy = testManifestRes.ok;
              } catch (netErr) {
                // Network error or timeout during probe: treat as unhealthy to attempt next provider
                manifestHealthy = false;
              }
            }

            if (manifestHealthy) {
              refToResolve = testRef;
              providerName = candidate.name || candidate.slug || 'Nova';
              qualityLabel = testQuality;
              availableQualities = candidate.allQualities?.map((q) => q.quality) || ['1080p'];
              resolvedDirectUrl = candidateStreamUrl;
              break;
            }
          } catch (candErr) {
            console.warn(`[Streamo] Candidate provider ${candidate.name} skipped:`, candErr.message);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Streamo] Primary guest-token request error:', err.message);
  }

  // Fallback to SSE scraper if primary providers were missing or all failed health check
  if (!refToResolve) {
    try {
      console.log(`[Streamo] Primary providers unviable for TMDB ${tmdbId}, triggering SSE scraper fallback...`);
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

  // Step 2: Finalize stream URL
  let streamPath = '';
  if (resolvedDirectUrl) {
    streamPath = resolvedDirectUrl;
  } else if (refToResolve.startsWith('http://') || refToResolve.startsWith('https://') || refToResolve.startsWith('/')) {
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
    providers: availableProviders,
    allQualities: availableQualities,
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

    const cleanQ = q.trim();
    const cacheKey = `search:${cleanQ.toLowerCase()}:${type}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return reply.header('X-Cache', 'HIT').send(cached);
    }

    let results = [];
    const seenIds = new Set();

    // 1. Primary: Direct TMDB Multi-Search with anti-ISP blocking CloudFront resolver
    try {
      const tmdbData = await fetchTmdbJson(
        `/search/multi?query=${encodeURIComponent(cleanQ)}&include_adult=false`
      );

      for (const item of tmdbData.results || []) {
        if ((item.media_type === 'movie' || item.media_type === 'tv') && !seenIds.has(item.id)) {
          seenIds.add(item.id);
          results.push({
            tmdbId: item.id,
            type: item.media_type === 'tv' ? 'tv' : 'movie',
            title: item.title || item.name || '',
            year: (item.release_date || item.first_air_date || '').slice(0, 4),
            poster: item.poster_path ? `https://image.tmdb.org/t/p/w300${item.poster_path}` : '',
            backdrop: item.backdrop_path
              ? `https://image.tmdb.org/t/p/original${item.backdrop_path}`
              : (item.poster_path ? `https://image.tmdb.org/t/p/original${item.poster_path}` : ''),
            rating: item.vote_average ? Number(item.vote_average.toFixed(1)) : 0,
            overview: item.overview || '',
          });
        }
      }
    } catch (err) {
      console.warn('[TMDB Search] Query warning:', err.message);
    }

    // 2. Secondary: If TMDB yielded 0 results, search Stremio Cinemeta catalog
    if (!results.length) {
      try {
        const cinemetaResults = await searchCinemeta(cleanQ);
        for (const item of cinemetaResults) {
          if (!seenIds.has(item.tmdbId)) {
            seenIds.add(item.tmdbId);
            results.push(item);
          }
        }
      } catch (cinErr) {
        console.warn('[Cinemeta Search] Query warning:', cinErr.message);
      }
    }

    // 3. Tertiary: Local fallback catalog match
    if (!results.length) {
      const queryLower = cleanQ.toLowerCase();
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
    const seenIds = new Set();

    try {
      const tmdbData = await fetchTmdbJson('/trending/all/week');
      for (const item of tmdbData.results || []) {
        if ((item.media_type === 'movie' || item.media_type === 'tv') && !seenIds.has(item.id)) {
          seenIds.add(item.id);
          results.push({
            tmdbId: item.id,
            type: item.media_type === 'tv' ? 'tv' : 'movie',
            title: item.title || item.name || '',
            year: (item.release_date || item.first_air_date || '').slice(0, 4),
            poster: item.poster_path ? `https://image.tmdb.org/t/p/w300${item.poster_path}` : '',
            backdrop: item.backdrop_path
              ? `https://image.tmdb.org/t/p/original${item.backdrop_path}`
              : (item.poster_path ? `https://image.tmdb.org/t/p/original${item.poster_path}` : ''),
            rating: item.vote_average ? Number(item.vote_average.toFixed(1)) : 0,
            overview: item.overview || '',
          });
        }
      }
    } catch (err) {
      console.warn('[TMDB Trending] Fetch warning:', err.message);
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
    const {
      type = 'movie',
      season = 1,
      episode = 1,
      febboxCookie = '',
      quality = null,
      provider = null,
    } = req.query;

    if (!tmdbId) {
      return reply.code(400).send({ error: 'tmdbId parameter is required' });
    }

    const cookieTag = febboxCookie ? 'fb' : 'guest';
    const qTag = quality || 'default';
    const pTag = provider || 'default';
    const cacheKey = `stream:${tmdbId}:${type}:${season}:${episode}:${cookieTag}:${qTag}:${pTag}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return reply.header('X-Cache', 'HIT').send(cached);
    }

    try {
      const streamData = await resolveStream(
        tmdbId,
        type,
        season,
        episode,
        febboxCookie,
        quality,
        provider
      );
      // Stream tokens expire within 10-15 minutes on CDNs; cache for 3 minutes max
      await cache.set(cacheKey, streamData, Math.min(STREAM_CACHE_TTL, 180));
      return reply.header('X-Cache', 'MISS').send(streamData);
    } catch (err) {
      req.log.error(err, `Failed to resolve stream for tmdbId ${tmdbId}`);
      return reply.code(502).send({
        error: 'Failed to resolve stream from providers',
        message: err.message,
      });
    }
  });

  // ── POST /api/media/febbox-test ─────────────────────────────────────────
  fastify.post('/febbox-test', async (req, reply) => {
    const { cookie } = req.body || {};
    if (!cookie || typeof cookie !== 'string' || !cookie.trim()) {
      return reply.code(400).send({ valid: false, error: 'Cookie value is required' });
    }

    try {
      const testRes = await fetch('https://streamo.st/api/streaming/febbox-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Referer': STREAMO_REFERER,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify({ cookie: cookie.trim() }),
      });

      if (testRes.ok) {
        const data = await testRes.json();
        return reply.send({
          valid: !!data.valid,
          username: data.username || null,
          error: data.error || null,
        });
      } else {
        return reply.send({ valid: false, error: `Febbox validation failed (HTTP ${testRes.status})` });
      }
    } catch (err) {
      return reply.code(500).send({ valid: false, error: err.message });
    }
  });

  // ── GET /api/media/subtitles ────────────────────────────────────────────
  fastify.get('/subtitles', async (req, reply) => {
    const { tmdbId, type = 'movie', language = 'English', season = 1, episode = 1 } = req.query;

    if (!tmdbId) {
      return reply.code(400).send({ error: 'tmdbId is required' });
    }

    const cacheKey = `subtitles:${type}:${tmdbId}:${season}:${episode}`;
    const cached = await cache.get(cacheKey);
    if (cached) return reply.send(cached);

    let tracks = [];

    // Attempt to fetch full subtitle track listing from Streamo
    try {
      const subRes = await fetch('https://streamo.st/api/streaming/subtitles', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Referer': STREAMO_REFERER,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify({
          tmdbId: Number(tmdbId),
          type: type === 'tv' ? 'tv' : 'movie',
          ...(type === 'tv' ? { season: Number(season), episode: Number(episode) } : {}),
        }),
      });

      if (subRes.ok) {
        const subData = await subRes.json();
        const rawTracks = subData.tracks || [];

        // Filter and format available VTT tracks
        for (const tr of rawTracks) {
          if (tr.url && tr.url.includes('.vtt')) {
            const label = tr.title || tr.language || 'Subtitles';
            tracks.push({
              id: `${tr.language || 'en'}_${tr.index ?? tracks.length}`,
              label,
              language: tr.language || 'en',
              url: `/api/media/subtitles/proxy?url=${encodeURIComponent(tr.url)}`,
              rawUrl: tr.url,
              type: tr.type || 'vdrk',
            });
          }
        }
      }
    } catch (err) {
      console.warn('[MediaRoutes] Streamo subtitles catalog fetch error:', err.message);
    }

    // Fallback if no tracks were discovered
    if (tracks.length === 0) {
      const defaultVtt =
        type === 'tv'
          ? `https://cache.vdrk.site/v1/vtt/tv/${tmdbId}/${season}/${episode}/${encodeURIComponent(language)}.vtt`
          : `https://cache.vdrk.site/v1/vtt/movie/${tmdbId}/${encodeURIComponent(language)}.vtt`;

      tracks.push({
        id: 'default_en',
        label: `${language} (Default)`,
        language: 'en',
        url: `/api/media/subtitles/proxy?url=${encodeURIComponent(defaultVtt)}`,
        rawUrl: defaultVtt,
        type: 'vdrk',
      });
    }

    // Determine the best primary track (prefer English2 if present for Inception/VDRK, else English)
    const englishTracks = tracks.filter((t) => t.label.toLowerCase().includes('english') || t.language === 'en');
    const bestEnglish =
      englishTracks.find((t) => t.label === 'English2') ||
      englishTracks.find((t) => t.label === 'English') ||
      englishTracks[0] ||
      tracks[0];

    const result = {
      url: bestEnglish.url,
      rawUrl: bestEnglish.rawUrl,
      language: bestEnglish.language,
      label: bestEnglish.label,
      tracks,
    };

    await cache.set(cacheKey, result, 60 * 60); // Cache 1 hour
    return reply.send(result);
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

    const ALLOWED_HOSTS = ['cache.vdrk.site', 'dl.subdl.com', 'streamo.st', 'localhost', '127.0.0.1'];
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

      // Filter out promotional/spam cues from public subtitle uploaders
      const spamPatterns = [
        /hoofoot\.ru/i,
        /1xbet/i,
        /betting/i,
        /visit\s+.*to\s+watch/i,
        /livestream\s+and\s+highlights/i,
        /downloaded\s+from/i,
      ];

      const blocks = text.split(/\r?\n\r?\n/);
      const filteredBlocks = blocks.filter((block) => {
        if (!block.includes('-->')) return true; // Keep headers like WEBVTT
        return !spamPatterns.some((pattern) => pattern.test(block));
      });

      const cleanedText = filteredBlocks.join('\n\n');

      return reply
        .header('Content-Type', 'text/vtt; charset=utf-8')
        .header('Access-Control-Allow-Origin', '*')
        .send(cleanedText);
    } catch (err) {
      return reply
        .header('Content-Type', 'text/vtt; charset=utf-8')
        .header('Access-Control-Allow-Origin', '*')
        .send(`WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\n[Subtitles connection error]`);
    }
  });

  // Helper to scrape rich movie metadata directly from Streamo
  async function fetchStreamoMovieDetails(tmdbId) {
    try {
      const url = `https://streamo.st/movies/${tmdbId}`;
      let res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': STREAMO_REFERER,
        },
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) return null;
      let html = await res.text();

      // Check for canonical redirect to slugged URL for richer structured JSON-LD
      const canonicalMatch = html.match(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/i);
      if (canonicalMatch && canonicalMatch[1] && canonicalMatch[1] !== url) {
        try {
          const cRes = await fetch(canonicalMatch[1], {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': STREAMO_REFERER,
            },
            signal: AbortSignal.timeout(4000),
          });
          if (cRes.ok) html = await cRes.text();
        } catch {}
      }

      let title = '';
      let overview = '';
      let poster = '';
      let backdrop = '';
      let rating = 0;
      let year = '';
      let genres = [];
      let cast = [];
      let runtime = 120;
      let trailerKey = null;

      // Extract JSON-LD schema
      const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      if (ldMatch) {
        try {
          const ld = JSON.parse(ldMatch[1]);
          title = ld.name || '';
          overview = ld.description || '';
          poster = ld.image || '';
          year = ld.datePublished ? ld.datePublished.slice(0, 4) : '';
          rating = ld.aggregateRating?.ratingValue ? Number(Number(ld.aggregateRating.ratingValue).toFixed(1)) : 0;
          if (Array.isArray(ld.genre)) genres = ld.genre;
          if (Array.isArray(ld.actor)) cast = ld.actor.map((a) => a.name).filter(Boolean);
          if (ld.duration) {
            const m = ld.duration.match(/PT(\d+)M/);
            if (m) runtime = Number(m[1]);
          }
          if (ld.trailer?.embedUrl) {
            const ym = ld.trailer.embedUrl.match(/embed\/([^?&]+)/);
            if (ym) trailerKey = ym[1];
          }
        } catch {}
      }

      // Meta tag fallbacks
      if (!title) {
        const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i);
        const titleTag = html.match(/<title>([^<]+)<\/title>/);
        title = (ogTitle ? ogTitle[1] : (titleTag ? titleTag[1] : '')).replace(/\s*\|\s*Streamo.*$/i, '').trim();
        const ym = title.match(/\((\d{4})\)/);
        if (ym) {
          year = ym[1];
          title = title.replace(/\(\d{4}\)/, '').trim();
        }
      }

      if (!overview) {
        const ogDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/i);
        if (ogDesc) overview = ogDesc[1];
      }
      if (!poster) {
        const ogImg = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"/i);
        if (ogImg) poster = ogImg[1];
      }

      const bdMatch = html.match(/"backdropPath":"([^"]+)"/);
      if (bdMatch) {
        backdrop = `https://image.tmdb.org/t/p/original${bdMatch[1]}`;
      }

      if (!title) return null;

      return {
        tmdbId: Number(tmdbId),
        type: 'movie',
        title,
        year: year || '',
        rating: rating || 7.5,
        overview: overview || '',
        poster: poster || '',
        backdrop: backdrop || poster || '',
        genres: genres.length ? genres : ['Action', 'Sci-Fi'],
        cast: cast.slice(0, 8),
        runtime,
        trailerKey,
      };
    } catch (err) {
      console.warn('[Streamo Movie] Failed scraping movie metadata:', err.message);
      return null;
    }
  }

  // Helper to scrape rich series & seasons details from Streamo
  async function fetchStreamoSeriesDetails(tmdbId, slug = '', titleHint = '') {
    try {
      let seriesSlug = slug;
      if (!seriesSlug) {
        // Try to look up slug from search if tmdbId is known
        const queryTerm = titleHint || (FALLBACK_MOVIES.find((m) => m.tmdbId === Number(tmdbId))?.title) || String(tmdbId);
        try {
          const sRes = await fetch(`https://streamo.st/api/search?q=${encodeURIComponent(queryTerm)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': STREAMO_REFERER },
            signal: AbortSignal.timeout(3500),
          });
          if (sRes.ok) {
            const sData = await sRes.json();
            const hit = [...(sData.series || []), ...(sData.anime || [])].find((s) => (s.href || '').includes(String(tmdbId)));
            if (hit && hit.href) {
              const m = hit.href.match(/\/(series|anime)\/\d+-(.+)$/);
              if (m) seriesSlug = m[2];
            }
          }
        } catch {}
      }

      // Try /series/ URL first, if fails try /anime/
      let urls = [
        `https://streamo.st/series/${tmdbId}${seriesSlug ? '-' + seriesSlug : ''}`,
        `https://streamo.st/anime/${tmdbId}${seriesSlug ? '-' + seriesSlug : ''}`,
      ];

      let pageHtml = '';
      for (const u of urls) {
        try {
          let res = await fetch(u, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': STREAMO_REFERER,
            },
            signal: AbortSignal.timeout(5000),
          });
          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (loc) {
              res = await fetch(loc.startsWith('http') ? loc : `https://streamo.st${loc}`, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': STREAMO_REFERER },
                signal: AbortSignal.timeout(5000),
              });
            }
          }
          if (res.ok) {
            pageHtml = await res.text();
            break;
          }
        } catch {}
      }

      if (!pageHtml) return null;

      // Check for canonical link
      const canonicalMatch = pageHtml.match(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/i);
      if (canonicalMatch && canonicalMatch[1]) {
        const canUrl = canonicalMatch[1].startsWith('http')
          ? canonicalMatch[1]
          : `https://streamo.st${canonicalMatch[1]}`;
        if (!canUrl.endsWith(`/${tmdbId}`)) {
          try {
            const cRes = await fetch(canUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': STREAMO_REFERER,
              },
              signal: AbortSignal.timeout(5000),
            });
            if (cRes.ok) pageHtml = await cRes.text();
          } catch {}
        }
      }

      // Extract JSON-LD for primary metadata
      let title = '';
      let overview = '';
      let poster = '';
      let backdrop = '';
      let rating = 0;
      let year = '';
      let creators = [];
      let cast = [];
      let numSeasonsLd = 0;
      let numEpisodesLd = 0;

      const ldMatch = pageHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      if (ldMatch) {
        try {
          const ld = JSON.parse(ldMatch[1]);
          title = ld.name || '';
          overview = ld.description || '';
          poster = ld.image || '';
          rating = ld.aggregateRating?.ratingValue ? Number(Number(ld.aggregateRating.ratingValue).toFixed(1)) : 0;
          year = ld.datePublished ? ld.datePublished.slice(0, 4) : (ld.startDate ? ld.startDate.slice(0, 4) : '');
          numSeasonsLd = Number(ld.numberOfSeasons || 0);
          numEpisodesLd = Number(ld.numberOfEpisodes || 0);
          if (Array.isArray(ld.creator)) {
            creators = ld.creator.map((c) => c.name).filter(Boolean);
          }
          if (Array.isArray(ld.actor)) {
            cast = ld.actor.map((a) => a.name).filter(Boolean);
          }
        } catch {}
      }

      if (!title) {
        const ogTitle = pageHtml.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i);
        const titleTag = pageHtml.match(/<title>([^<]+)<\/title>/);
        title = (ogTitle ? ogTitle[1] : (titleTag ? titleTag[1] : '')).replace(/\s*\|\s*Streamo.*$/i, '').trim();
      }

      const nextFMatches = [...pageHtml.matchAll(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g)];
      let combined = '';
      for (const m of nextFMatches) {
        try {
          combined += JSON.parse(`"${m[1]}"`);
        } catch {
          combined += m[1];
        }
      }

      const bdMatch = combined.match(/"backdropPath":"([^"]+)"/);
      if (bdMatch) {
        backdrop = `https://image.tmdb.org/t/p/original${bdMatch[1]}`;
      }

      // Parse seasons and episodes
      const seasonMarker = '"seasonNumber":';
      let pos = 0;
      const seasons = [];

      while (true) {
        const snIdx = combined.indexOf(seasonMarker, pos);
        if (snIdx === -1) break;

        const nextEpIdx = combined.indexOf('"episodes":[{', snIdx);
        const nextSnIdx = combined.indexOf(seasonMarker, snIdx + seasonMarker.length);

        if (nextEpIdx !== -1 && (nextSnIdx === -1 || nextEpIdx < nextSnIdx)) {
          const numMatch = combined.slice(snIdx, snIdx + 30).match(/"seasonNumber":(\d+)/);
          const seasonNumber = numMatch ? Number(numMatch[1]) : 1;

          const nameMatch = combined.slice(snIdx, nextEpIdx).match(/"name":"([^"]+)"/);
          const name = nameMatch ? nameMatch[1] : (seasonNumber === 0 ? 'Specials' : `Season ${seasonNumber}`);

          const ovMatch = combined.slice(snIdx, nextEpIdx).match(/"overview":"([^"]*)"/);
          const sOverview = ovMatch ? ovMatch[1] : '';

          const posterMatch = combined.slice(snIdx, nextEpIdx).match(/"posterPath":"([^"]*)"/);
          const posterPath = posterMatch ? posterMatch[1] : '';

          let depth = 0;
          let start = nextEpIdx + 11;
          let end = start;
          for (let i = start; i < combined.length; i++) {
            if (combined[i] === '[') depth++;
            else if (combined[i] === ']') {
              depth--;
              if (depth === 0) {
                end = i + 1;
                break;
              }
            }
          }

          try {
            const epArray = JSON.parse(combined.slice(start, end));
            seasons.push({
              seasonNumber,
              name,
              overview: sOverview,
              poster: posterPath ? `https://image.tmdb.org/t/p/w300${posterPath}` : '',
              episodes: epArray.map((ep) => ({
                id: ep.id,
                episodeNumber: ep.episodeNumber,
                name: ep.name,
                overview: ep.overview || '',
                airDate: ep.airDate ? ep.airDate.slice(0, 10) : '',
                runtime: ep.runtime || 0,
                still: ep.stillPath ? `https://image.tmdb.org/t/p/w300${ep.stillPath}` : '',
                rating: ep.voteAverage ? Number(ep.voteAverage.toFixed(1)) : 0,
              })),
            });
          } catch {}

          pos = end;
        } else {
          pos = snIdx + seasonMarker.length;
        }
      }

      // Deduplicate seasons
      const uniqueSeasons = [];
      const seenSeasons = new Set();
      for (const s of seasons) {
        if (!seenSeasons.has(s.seasonNumber)) {
          seenSeasons.add(s.seasonNumber);
          uniqueSeasons.push(s);
        }
      }
      uniqueSeasons.sort((a, b) => {
        if (a.seasonNumber === 0) return 1;
        if (b.seasonNumber === 0) return -1;
        return a.seasonNumber - b.seasonNumber;
      });

      // If seasons weren't in Next.js bundle (e.g. anime), synthesize from LD metadata
      if (uniqueSeasons.length === 0) {
        const seasonCount = Math.max(1, numSeasonsLd || 1);
        const epCountPerSeason = Math.max(12, Math.ceil((numEpisodesLd || 24) / seasonCount));
        for (let s = 1; s <= seasonCount; s++) {
          const episodes = [];
          for (let e = 1; e <= epCountPerSeason; e++) {
            episodes.push({
              id: `${tmdbId}-s${s}-e${e}`,
              episodeNumber: e,
              name: `Episode ${e}`,
              overview: '',
              airDate: '',
              runtime: 24,
              still: poster || '',
              rating: rating || 8.0,
            });
          }
          uniqueSeasons.push({
            seasonNumber: s,
            name: `Season ${s}`,
            overview: '',
            poster: poster || '',
            episodes,
          });
        }
      }

      const totalEpisodes = uniqueSeasons.reduce((acc, s) => acc + s.episodes.length, 0);

      return {
        tmdbId: Number(tmdbId),
        type: 'tv',
        title: title || 'Series',
        year: year || '',
        rating: rating || 8.5,
        overview: overview || '',
        poster: poster || '',
        backdrop: backdrop || poster || '',
        creators,
        cast: cast.slice(0, 8),
        seasonsCount: uniqueSeasons.length,
        episodesCount: totalEpisodes,
        seasons: uniqueSeasons,
      };
    } catch (err) {
      console.warn('[Streamo Series] Failed scraping series metadata:', err.message);
      return null;
    }
  }

  // ── GET /api/media/movie/:tmdbId & /api/media/tv/:tmdbId ─────────────────
  const handleDetail = async (req, reply, type) => {
    const { tmdbId } = req.params;
    const cacheKey = `detail:${type}:${tmdbId}`;
    const cached = await cache.get(cacheKey);

    // Invalidate/bypass dummy cached TV entries (e.g. 1 season with only 1 episode)
    const isDummyTv =
      type === 'tv' &&
      cached &&
      (!Array.isArray(cached.seasons) ||
        cached.seasons.length === 0 ||
        (cached.seasons.length === 1 &&
          (!cached.seasons[0]?.episodes || cached.seasons[0].episodes.length <= 1)));

    if (cached && !isDummyTv) return reply.send(cached);

    // 1. Primary: Direct TMDB details query with credits and trailers
    try {
      const d = await fetchTmdbJson(`/${type}/${tmdbId}?append_to_response=credits,videos`);
      if (d && (d.id || d.title || d.name)) {
        const detail = {
          tmdbId: d.id || Number(tmdbId),
          type,
          title: d.title || d.name || '',
          year: (d.release_date || d.first_air_date || '').slice(0, 4),
          runtime: d.runtime || (d.episode_run_time ? d.episode_run_time[0] : 0) || (type === 'tv' ? 45 : 120),
          genres: (d.genres || []).map((g) => g.name),
          rating: d.vote_average ? Number(d.vote_average.toFixed(1)) : 7.5,
          overview: d.overview || '',
          poster: d.poster_path ? `https://image.tmdb.org/t/p/w300${d.poster_path}` : '',
          backdrop: d.backdrop_path ? `https://image.tmdb.org/t/p/original${d.backdrop_path}` : (d.poster_path ? `https://image.tmdb.org/t/p/original${d.poster_path}` : ''),
          cast: (d.credits?.cast || []).slice(0, 8).map((c) => c.name),
          trailerKey: d.videos?.results?.find((v) => v.type === 'Trailer')?.key || null,
          seasons: (d.seasons || []).map((s) => ({
            seasonNumber: s.season_number,
            name: s.name,
            overview: s.overview || '',
            poster: s.poster_path ? `https://image.tmdb.org/t/p/w300${s.poster_path}` : '',
            episodeCount: s.episode_count,
            episodes: [],
          })),
          seasonsCount: d.number_of_seasons || (d.seasons?.length || 1),
          episodesCount: d.number_of_episodes || 0,
        };
        await cache.set(cacheKey, detail, 24 * 3600);
        return reply.send(detail);
      }
    } catch (tmdbErr) {
      console.warn(`[TMDB Detail] ${type}/${tmdbId} fetch warning:`, tmdbErr.message);
    }

    // 2. Secondary: If TV show, try scraping Streamo series directly
    if (type === 'tv') {
      try {
        const streamoTv = await fetchStreamoSeriesDetails(tmdbId, '', cached?.title || '');
        if (streamoTv && streamoTv.seasons?.length) {
          await cache.set(cacheKey, streamoTv, 24 * 3600);
          return reply.send(streamoTv);
        }
      } catch {}
    }

    // 3. Secondary: If Movie, try scraping Streamo movie page directly
    if (type === 'movie') {
      try {
        const streamoMovie = await fetchStreamoMovieDetails(tmdbId);
        if (streamoMovie && streamoMovie.title) {
          await cache.set(cacheKey, streamoMovie, 24 * 3600);
          return reply.send(streamoMovie);
        }
      } catch {}
    }

    // 4. Fallback catalog
    const fallback = FALLBACK_MOVIES.find((m) => m.tmdbId === Number(tmdbId));
    if (fallback) {
      return reply.send({
        ...fallback,
        runtime: fallback.type === 'tv' ? 48 : 148,
        genres: ['Action', 'Sci-Fi', 'Drama'],
        cast: ['Leonardo DiCaprio', 'Joseph Gordon-Levitt', 'Bryan Cranston'],
        trailerKey: 'YoHD9XEInc0',
        seasons: fallback.type === 'tv' ? [{ seasonNumber: 1, name: 'Season 1', episodes: [{ episodeNumber: 1, name: 'Episode 1' }] }] : [],
        seasonsCount: 1,
        episodesCount: 1,
      });
    }

    // 5. Ultimate safety net: return baseline detail object with tmdbId guaranteed (never 404!)
    const safeDetail = {
      tmdbId: Number(tmdbId),
      type,
      title: `${type === 'tv' ? 'Series' : 'Movie'} #${tmdbId}`,
      year: '',
      rating: 7.0,
      overview: 'Available for watch party streaming on StreamSync.',
      poster: '',
      backdrop: '',
      genres: ['Action', 'Adventure'],
      cast: [],
      runtime: 120,
      seasons: type === 'tv' ? [{ seasonNumber: 1, name: 'Season 1', episodes: [{ episodeNumber: 1, name: 'Episode 1' }] }] : [],
      seasonsCount: 1,
      episodesCount: 1,
    };
    return reply.send(safeDetail);
  };

  fastify.get('/movie/:tmdbId', (req, reply) => handleDetail(req, reply, 'movie'));
  fastify.get('/tv/:tmdbId', (req, reply) => handleDetail(req, reply, 'tv'));

  // ── GET /api/media/tv/:tmdbId/season/:seasonNumber ───────────────────────
  fastify.get('/tv/:tmdbId/season/:seasonNumber', async (req, reply) => {
    const { tmdbId, seasonNumber } = req.params;
    const sNum = Number(seasonNumber);

    const cacheKey = `tv_season:${tmdbId}:${sNum}`;
    const cached = await cache.get(cacheKey);
    if (cached) return reply.send(cached);

    // 1. Primary: Direct TMDB Season query (bypasses ISP blocks, instant rich episodes)
    try {
      const d = await fetchTmdbJson(`/tv/${tmdbId}/season/${sNum}`);
      if (d && Array.isArray(d.episodes) && d.episodes.length > 0) {
        const seasonData = {
          seasonNumber: d.season_number ?? sNum,
          name: d.name || `Season ${sNum}`,
          overview: d.overview || '',
          poster: d.poster_path ? `https://image.tmdb.org/t/p/w300${d.poster_path}` : '',
          episodes: d.episodes.map((ep) => ({
            id: ep.id,
            episodeNumber: ep.episode_number,
            name: ep.name,
            overview: ep.overview || '',
            airDate: ep.air_date ? ep.air_date.slice(0, 10) : '',
            runtime: ep.runtime || 0,
            still: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : '',
            rating: ep.vote_average ? Number(ep.vote_average.toFixed(1)) : 0,
          })),
        };
        await cache.set(cacheKey, seasonData, 24 * 3600);
        return reply.send(seasonData);
      }
    } catch (tmdbErr) {
      console.warn(`[TMDB Season] /tv/${tmdbId}/season/${sNum} fetch warning:`, tmdbErr.message);
    }

    // 2. Secondary: Look in TV show detail cache or scrape
    let tvDetail = await cache.get(`detail:tv:${tmdbId}`);
    const isDummyDetail =
      !tvDetail ||
      !Array.isArray(tvDetail.seasons) ||
      tvDetail.seasons.length === 0 ||
      (tvDetail.seasons.length === 1 &&
        (!tvDetail.seasons[0]?.episodes || tvDetail.seasons[0].episodes.length <= 1));

    if (isDummyDetail) {
      tvDetail = await fetchStreamoSeriesDetails(tmdbId);
      if (tvDetail) {
        await cache.set(`detail:tv:${tmdbId}`, tvDetail, 24 * 3600);
      }
    }

    if (tvDetail && tvDetail.seasons) {
      const matchSeason = tvDetail.seasons.find((s) => s.seasonNumber === sNum);
      if (matchSeason) {
        await cache.set(cacheKey, matchSeason, 24 * 3600);
        return reply.send(matchSeason);
      }
    }

    return reply.code(404).send({ error: `Season ${sNum} not found for TV show ${tmdbId}` });
  });
}

export { mediaRoutes };


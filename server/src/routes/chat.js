/**
 * StreamSync - Rich Chat Route Plugin
 * Endpoints for Sticker Pack Manifests and Tenor GIF search & trending proxies.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cache } from '../core/cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STICKERS_MANIFEST_PATH = path.join(__dirname, '..', '..', 'public', 'stickers', 'manifest.json');

const TENOR_KEY = process.env.TENOR_API_KEY || 'LIVDSRZULELA';

// High-reliability curated fallback GIFs for cinematic and party watch reactions
const FALLBACK_GIFS = [
  {
    id: 'popcorn_classic',
    url: 'https://media.tenor.com/wws9qeD0E74AAAAM/popcorn-guy-extra-butter.gif',
    preview: 'https://media.tenor.com/wws9qeD0E74AAAAM/popcorn-guy-extra-butter.gif',
    width: 220,
    height: 160,
  },
  {
    id: 'cinema_cheer',
    url: 'https://media.tenor.com/mqzuK_iOjzYAAAAC/leonardo-dicaprio-cheers.gif',
    preview: 'https://media.tenor.com/mqzuK_iOjzYAAAAC/leonardo-dicaprio-cheers.gif',
    width: 220,
    height: 140,
  },
  {
    id: 'mind_blown',
    url: 'https://media.tenor.com/Yjx_r38x1aYAAAAM/mind-blown-explosion.gif',
    preview: 'https://media.tenor.com/Yjx_r38x1aYAAAAM/mind-blown-explosion.gif',
    width: 220,
    height: 180,
  },
  {
    id: 'clapping_applause',
    url: 'https://media.tenor.com/1vzjD25uEjcAAAAM/clapping-great-news.gif',
    preview: 'https://media.tenor.com/1vzjD25uEjcAAAAM/clapping-great-news.gif',
    width: 220,
    height: 150,
  },
  {
    id: 'thumbs_up_like',
    url: 'https://media.tenor.com/YXJb-GI93WYAAAAM/like.gif',
    preview: 'https://media.tenor.com/YXJb-GI93WYAAAAM/like.gif',
    width: 220,
    height: 160,
  },
  {
    id: 'thumbs_up_cool',
    url: 'https://media.tenor.com/CWSOrI3jpNUAAAAM/thumbs-up-cool.gif',
    preview: 'https://media.tenor.com/CWSOrI3jpNUAAAAM/thumbs-up-cool.gif',
    width: 220,
    height: 160,
  },
];

/**
 * Normalizes Tenor API v2 responses into a clean, lightweight payload
 * stripping unnecessary trackers and metadata.
 */
function normalizeTenorResults(results) {
  if (!Array.isArray(results)) return [];
  return results
    .map((item) => {
      const media = item.media_formats || {};
      const gif = media.gif || media.mediumgif || media.tinygif;
      const preview = media.tinygif || media.nanogif || gif;
      if (!gif?.url) return null;

      const dims = gif.dims || [200, 200];
      return {
        id: item.id || `gif_${Math.random().toString(36).slice(2, 9)}`,
        url: gif.url,
        preview: preview?.url || gif.url,
        width: dims[0] || 200,
        height: dims[1] || 200,
      };
    })
    .filter(Boolean);
}

/**
 * Fastify route plugin for Chat resources
 */
export default async function chatRoutes(fastify) {
  // ── GET /api/chat/stickers ──────────────────────────────────────────────
  fastify.get('/stickers', async (req, reply) => {
    const cacheKey = 'chat:stickers:manifest';
    const cached = await cache.get(cacheKey);
    if (cached) {
      return reply.header('X-Cache', 'HIT').send(cached);
    }

    try {
      if (fs.existsSync(STICKERS_MANIFEST_PATH)) {
        const raw = fs.readFileSync(STICKERS_MANIFEST_PATH, 'utf-8');
        const manifest = JSON.parse(raw);
        await cache.set(cacheKey, manifest, 24 * 3600);
        return reply.header('X-Cache', 'MISS').send(manifest);
      }
    } catch (err) {
      fastify.log.warn({ err: err.message }, 'Failed reading stickers manifest');
    }

    // Default built-in fallback manifest
    const fallbackManifest = [
      {
        packId: 'movie',
        name: 'Cinema Reactions',
        preview: '/stickers/movie/0.svg',
        count: 12,
      },
    ];
    return reply.send(fallbackManifest);
  });

  // ── GET /api/chat/gif/search ────────────────────────────────────────────
  fastify.get('/gif/search', async (req, reply) => {
    const { q, limit = 20 } = req.query;
    if (!q || typeof q !== 'string' || !q.trim()) {
      return reply.code(400).send({ error: 'Search query q is required' });
    }

    const queryKey = q.trim().toLowerCase();
    const cacheKey = `gif:${queryKey}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return reply.header('X-Cache', 'HIT').send(cached);
    }

    try {
      const tenorUrl = `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(
        queryKey
      )}&key=${TENOR_KEY}&limit=${Math.min(Number(limit) || 20, 50)}&media_filter=gif,tinygif`;

      const res = await fetch(tenorUrl, {
        headers: { 'User-Agent': 'StreamSync/1.1.0' },
        signal: AbortSignal.timeout(4500),
      });

      if (res.ok) {
        const data = await res.json();
        const normalized = normalizeTenorResults(data.results);
        if (normalized.length > 0) {
          // Cache in Redis/memory with 1 hour TTL
          await cache.set(cacheKey, normalized, 3600);
          return reply.header('X-Cache', 'MISS').send(normalized);
        }
      }
    } catch (err) {
      fastify.log.warn({ err: err.message }, 'Tenor GIF search failed, using fallback');
    }

    // Filter fallback GIFs matching query or return default set
    const matchedFallback = FALLBACK_GIFS.filter((g) => g.id.includes(queryKey));
    const results = matchedFallback.length ? matchedFallback : FALLBACK_GIFS;
    await cache.set(cacheKey, results, 300);
    return reply.header('X-Cache', 'FALLBACK').send(results);
  });

  // ── GET /api/chat/gif/trending ──────────────────────────────────────────
  fastify.get('/gif/trending', async (req, reply) => {
    const { limit = 20 } = req.query;
    const cacheKey = 'gif:trending';
    const cached = await cache.get(cacheKey);
    if (cached) {
      return reply.header('X-Cache', 'HIT').send(cached);
    }

    try {
      const tenorUrl = `https://tenor.googleapis.com/v2/featured?key=${TENOR_KEY}&limit=${Math.min(
        Number(limit) || 20,
        50
      )}&media_filter=gif,tinygif`;

      const res = await fetch(tenorUrl, {
        headers: { 'User-Agent': 'StreamSync/1.1.0' },
        signal: AbortSignal.timeout(4500),
      });

      if (res.ok) {
        const data = await res.json();
        const normalized = normalizeTenorResults(data.results);
        if (normalized.length > 0) {
          // Cache in Redis/memory with 30 min TTL
          await cache.set(cacheKey, normalized, 1800);
          return reply.header('X-Cache', 'MISS').send(normalized);
        }
      }
    } catch (err) {
      fastify.log.warn({ err: err.message }, 'Tenor trending fetch failed, using fallback');
    }

    await cache.set(cacheKey, FALLBACK_GIFS, 600);
    return reply.header('X-Cache', 'FALLBACK').send(FALLBACK_GIFS);
  });

  // ── GET /api/chat/gif/proxy ─────────────────────────────────────────────
  fastify.get('/gif/proxy', async (req, reply) => {
    const { url } = req.query;
    if (!url || typeof url !== 'string') {
      return reply.code(400).send({ error: 'url parameter required' });
    }

    try {
      const decodedUrl = decodeURIComponent(url);
      const parsed = new URL(decodedUrl);
      if (!parsed.hostname.includes('tenor.com') && !parsed.hostname.includes('giphy.com')) {
        return reply.code(403).send({ error: 'Domain not allowed for GIF proxy' });
      }

      const res = await fetch(decodedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Referer': 'https://tenor.com/'
        },
        signal: AbortSignal.timeout(6000)
      });

      if (!res.ok) {
        return reply.code(res.status).send({ error: `Remote returned ${res.status}` });
      }

      const contentType = res.headers.get('content-type') || 'image/gif';
      const buffer = Buffer.from(await res.arrayBuffer());

      return reply
        .header('Content-Type', contentType)
        .header('Access-Control-Allow-Origin', '*')
        .header('Cache-Control', 'public, max-age=3600')
        .send(buffer);
    } catch (err) {
      fastify.log.warn({ err: err.message }, 'GIF proxy failed');
      return reply.code(502).send({ error: 'Failed to proxy GIF' });
    }
  });
}


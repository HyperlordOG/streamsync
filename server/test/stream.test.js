import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mediaRoutes } from '../src/routes/media.js';

describe('StreamSync - Streamo Streaming Pipeline Integration', { concurrency: 1 }, () => {
  let app;
  let originalFetch;

  before(async () => {
    originalFetch = globalThis.fetch;
    app = Fastify();
    await app.register(mediaRoutes, { prefix: '/api/media' });
    await app.ready();
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
  });

  test('Streamo pipeline: resolves stream with provider sorting and quality ref', async () => {
    // Mock upstream Streamo endpoints
    globalThis.fetch = async (url, opts) => {
      const urlStr = String(url);

      if (urlStr.includes('/api/streaming/guest-token')) {
        assert.equal(opts.method, 'POST');
        assert.equal(opts.headers?.Referer, 'https://streamo.st/');
        const body = JSON.parse(opts.body);
        assert.equal(body.tmdbId, 27205);

        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              token: 'mock-jwt-stoken-6767',
              providers: [
                {
                  name: 'zenith',
                  kind: 'zenith',
                  url: 'ref-zenith-default',
                  allQualities: [
                    { quality: '720p', url: 'ref-zenith-720p' },
                    { quality: '1080p', url: 'ref-zenith-1080p' }
                  ]
                },
                {
                  name: 'relay',
                  kind: 'relay',
                  url: 'ref-relay-default',
                  allQualities: [
                    { quality: '1080p', url: 'ref-relay-1080p' }
                  ]
                }
              ]
            }
          })
        };
      }

      if (urlStr.includes('/api/streaming/resolve')) {
        assert.ok(urlStr.includes('ref=ref-relay-1080p'));
        assert.ok(urlStr.includes('stoken=mock-jwt-stoken-6767'));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            url: '/api/streaming/proxy?ref=ref-relay-1080p&type=hls&referer=https%3A%2F%2Fcdn.vidspark.to%2F'
          })
        };
      }

      return originalFetch(url, opts);
    };

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/stream/27205?type=movie'
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();

    assert.equal(body.streamUrl, 'https://streamo.st/api/streaming/proxy?ref=ref-relay-1080p&type=hls&referer=https%3A%2F%2Fcdn.vidspark.to%2F');
    assert.equal(body.provider, 'relay');
    assert.equal(body.quality, '1080p');
    assert.ok(body.subtitlesUrl.includes('/api/media/subtitles'));
    // Security check: raw stoken JWT must NOT be returned to client
    assert.equal(body.stoken, undefined);
  });

  test('SSE Fallback: triggers when primary guest-token / resolve fails', async () => {
    globalThis.fetch = async (url, opts) => {
      const urlStr = String(url);

      if (urlStr.includes('/api/streaming/guest-token')) {
        return {
          ok: false,
          status: 503,
          text: async () => 'Primary gateway unavailable'
        };
      }

      if (urlStr.includes('/api/streaming/scrape-stream')) {
        // Return SSE stream response
        const encoder = new TextEncoder();
        const payload = `data: {"sources":[{"url":"/api/streaming/proxy?ref=fallback-sse-ref&type=hls","quality":"1080p","provider":"vidrift"}]}\n\n`;
        let sent = false;

        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: async () => {
                if (!sent) {
                  sent = true;
                  return { done: false, value: encoder.encode(payload) };
                }
                return { done: true, value: undefined };
              },
              cancel: async () => {}
            })
          }
        };
      }

      return originalFetch(url, opts);
    };

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/stream/27206?type=movie'
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.streamUrl.includes('fallback-sse-ref'));
    assert.equal(body.fallback, true);
  });

  test('Subtitles proxy: returns text/vtt and Access-Control-Allow-Origin: *', async () => {
    globalThis.fetch = async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes('cache.vdrk.site')) {
        return {
          ok: true,
          status: 200,
          text: async () => `WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nInception subtitles active`
        };
      }
      return originalFetch(url, opts);
    };

    const targetUrl = 'https://cache.vdrk.site/v1/vtt/movie/27205/English.vtt';
    const res = await app.inject({
      method: 'GET',
      url: `/api/media/subtitles/proxy?url=${encodeURIComponent(targetUrl)}`
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/vtt'));
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.ok(res.body.includes('WEBVTT'));
    assert.ok(res.body.includes('Inception subtitles active'));
  });

  test('Search: returns normalized array schema', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/media/search?q=inception&type=movie'
    });

    assert.equal(res.statusCode, 200);
    const items = res.json();
    assert.ok(Array.isArray(items));
    assert.ok(items.length > 0);

    const first = items[0];
    assert.ok(first.tmdbId);
    assert.ok(first.title);
    assert.ok(first.poster);
  });
});

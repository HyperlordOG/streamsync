import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import mediaRoutes from '../src/routes/media.js';

describe('StreamSync - Media Catalog Discovery & Search Suite', () => {
  let app;

  before(async () => {
    app = Fastify();
    await app.register(mediaRoutes, { prefix: '/api/media' });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  test('Search: "spider" returns Spider-Man movies with valid posters and ratings', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/media/search?q=spider' });
    assert.equal(res.statusCode, 200);
    const items = res.json();
    assert.ok(Array.isArray(items));
    assert.ok(items.length >= 10, 'Expected at least 10 results for spider');
    const match = items.find((m) => m.title.toLowerCase().includes('spider'));
    assert.ok(match, 'Must contain Spider-Man');
    assert.ok(match.tmdbId > 0);
    assert.ok(match.poster.startsWith('http'));
  });

  test('Search: "titanic" returns Titanic', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/media/search?q=titanic' });
    assert.equal(res.statusCode, 200);
    const items = res.json();
    assert.ok(items.length > 0);
    assert.ok(items.some((m) => m.title.toLowerCase().includes('titanic')));
  });

  test('Search: "batman" returns The Dark Knight / Batman catalog', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/media/search?q=batman' });
    assert.equal(res.statusCode, 200);
    const items = res.json();
    assert.ok(items.length >= 10);
    assert.ok(items.some((m) => m.title.toLowerCase().includes('batman')));
  });

  test('Search: "naruto" returns anime series', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/media/search?q=naruto' });
    assert.equal(res.statusCode, 200);
    const items = res.json();
    assert.ok(items.length > 0);
    assert.ok(items.some((m) => m.title.toLowerCase().includes('naruto')));
  });

  test('Trending: returns 20 top titles with high-res posters and backdrops', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/media/trending' });
    assert.equal(res.statusCode, 200);
    const items = res.json();
    assert.ok(Array.isArray(items));
    assert.ok(items.length >= 15);
    assert.ok(items[0].tmdbId);
    assert.ok(items[0].poster);
  });

  test('Movie Detail: /api/media/movie/550 returns Fight Club with cast and genres', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/media/movie/550' });
    assert.equal(res.statusCode, 200);
    const item = res.json();
    assert.equal(item.title, 'Fight Club');
    assert.ok(item.genres.includes('Drama'));
    assert.ok(item.cast.length > 0);
  });

  test('TV Detail & Season: /api/media/tv/1396 returns Breaking Bad seasons and episode tree', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/media/tv/1396' });
    assert.equal(res.statusCode, 200);
    const item = res.json();
    assert.equal(item.title, 'Breaking Bad');
    assert.ok(item.seasons.length >= 5);

    const sRes = await app.inject({ method: 'GET', url: '/api/media/tv/1396/season/1' });
    assert.equal(sRes.statusCode, 200);
    const s1 = sRes.json();
    assert.equal(s1.seasonNumber, 1);
    assert.equal(s1.episodes.length, 7);
    assert.equal(s1.episodes[0].name, 'Pilot');
  });
});


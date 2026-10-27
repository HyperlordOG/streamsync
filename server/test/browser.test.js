import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Setup minimal DOM environment for MovieBrowser ES module testing
class MockElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this._innerHTML = '';
    this.eventListeners = {};
    this.classList = {
      add: () => {},
      remove: () => {},
      contains: () => false
    };
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(html) {
    this._innerHTML = html;
    this.children = [];

    // Parse simple movie-card divs for querySelectorAll
    const cardRegex = /<div class="movie-card"[^>]*data-tmdb-id="([^"]+)"[^>]*data-type="([^"]+)"/g;
    let match;
    while ((match = cardRegex.exec(html)) !== null) {
      const card = new MockElement('div');
      card.className = 'movie-card';
      card.attributes['data-tmdb-id'] = match[1];
      card.attributes['data-type'] = match[2];
      this.children.push(card);
    }
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  setAttribute(name, val) {
    this.attributes[name] = val;
  }

  querySelector(sel) {
    if (sel === '#sb-grid') {
      if (!this._sbGrid) this._sbGrid = new MockElement('div');
      return this._sbGrid;
    }
    if (sel.includes('.movie-card')) {
      return this.querySelectorAll('.movie-card')[0] || null;
    }
    return new MockElement('div');
  }

  querySelectorAll(sel) {
    if (sel.includes('.movie-card')) {
      const fromGrid = this._sbGrid ? this._sbGrid.children : [];
      return [...this.children, ...fromGrid];
    }
    return [];
  }

  addEventListener(event, fn) {
    this.eventListeners[event] = fn;
  }

  appendChild(child) {
    this.children.push(child);
  }
}

describe('MovieBrowser Client Module', () => {
  let MovieBrowser;
  let originalFetch;
  let originalDocument;
  let originalWindow;

  before(async () => {
    originalFetch = globalThis.fetch;
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;

    globalThis.document = {
      getElementById: () => null,
      createElement: (tag) => new MockElement(tag),
      head: new MockElement('head')
    };
    globalThis.window = {
      addEventListener: () => {}
    };

    // Dynamic import of client module
    const mod = await import('../public/js/movie-browser.js');
    MovieBrowser = mod.MovieBrowser;
  });

  after(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  });

  test('MovieBrowser.search("inception") fetches /api/media/search?q=inception and renders movie cards with data-tmdb-id', async () => {
    let capturedUrl = '';

    globalThis.fetch = async (url) => {
      capturedUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            tmdbId: 27205,
            type: 'movie',
            title: 'Inception',
            year: '2010',
            poster: 'https://image.tmdb.org/t/p/w300/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg',
            rating: '8.4',
            overview: 'Cobb steals information from targets while they dream.'
          }
        ]
      };
    };

    const container = new MockElement('div');
    const onSelect = () => {};
    const browser = new MovieBrowser(container, onSelect);

    await browser.search('inception');

    assert.ok(capturedUrl.includes('/api/media/search'));
    assert.ok(capturedUrl.includes('q=inception'));

    const cards = container.querySelectorAll('.movie-card');
    assert.ok(cards.length >= 1, 'Expected at least one movie card');

    const firstCard = cards[0];
    assert.equal(firstCard.getAttribute('data-tmdb-id'), '27205');
    assert.equal(firstCard.getAttribute('data-type'), 'movie');
  });
});

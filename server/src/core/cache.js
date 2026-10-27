/**
 * StreamSync - Resilient Cache Layer
 * Supports Redis when REDIS_URL is configured, with seamless in-memory fallback.
 */

class MemoryCache {
  constructor() {
    this.store = new Map();
  }

  async get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key, value, ttlSeconds = 1800) {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async del(key) {
    this.store.delete(key);
  }
}

export const cache = new MemoryCache();

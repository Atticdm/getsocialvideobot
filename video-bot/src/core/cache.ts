import Redis from 'ioredis';
import { config } from './config';
import { logger } from './logger';

interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

class MemoryCache implements CacheClient {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.store.set(key, { value, expiresAt });
  }
}

let client: CacheClient;

if (config.REDIS_URL) {
  try {
    const redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });

    redis.on('error', (error) => {
      logger.error('Redis error', { error: error.message });
    });

    redis.on('connect', () => {
      logger.info('Redis connected for metadata cache');
    });

    void redis.connect().catch((error) => {
      logger.error('Redis initial connection failed, falling back to in-memory cache', { error: error.message });
    });

    client = {
      async get(key) {
        const value = await redis.get(key);
        return value ?? null;
      },
      async set(key, value, ttlSeconds) {
        await redis.set(key, value, 'EX', ttlSeconds);
      },
    };
  } catch (error: any) {
    logger.error('Redis unavailable, using in-memory cache', { error: error?.message || error });
    client = new MemoryCache();
  }
} else {
  client = new MemoryCache();
}

const prefix = config.CACHE_PREFIX || 'yeet:';
const defaultTtl = config.CACHE_TTL_SECONDS || 3600;

export async function cacheGet(key: string): Promise<string | null> {
  return client.get(prefix + key);
}

export async function cacheSet(key: string, value: string, ttlSeconds: number = defaultTtl): Promise<void> {
  await client.set(prefix + key, value, ttlSeconds);
}

export async function withCache<T>(key: string, loader: () => Promise<T>, ttlSeconds: number = defaultTtl): Promise<T> {
  const cached = await cacheGet(key);
  if (cached) {
    try {
      return JSON.parse(cached) as T;
    } catch (error) {
      logger.warn('Failed to parse cached value, ignoring', { key, error });
    }
  }

  const loaded = await loader();
  try {
    await cacheSet(key, JSON.stringify(loaded), ttlSeconds);
  } catch (error) {
    logger.warn('Failed to set cache entry', { key, error });
  }
  return loaded;
}

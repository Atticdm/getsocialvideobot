import { config } from '../config';
import { logger } from '../logger';

let adminUserIdsCache: Set<number> | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function parseAdminUserIds(): Set<number> {
  if (!config.ADMIN_USER_IDS || config.ADMIN_USER_IDS.trim().length === 0) {
    return new Set();
  }

  const ids = config.ADMIN_USER_IDS
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .map((id) => {
      const parsed = parseInt(id, 10);
      if (isNaN(parsed)) {
        logger.warn({ invalidId: id }, 'Invalid admin user ID in config');
        return null;
      }
      return parsed;
    })
    .filter((id): id is number => id !== null);

  return new Set(ids);
}

function getAdminUserIds(): Set<number> {
  const now = Date.now();
  
  // Invalidate cache after TTL
  if (!adminUserIdsCache || now - cacheTimestamp > CACHE_TTL_MS) {
    adminUserIdsCache = parseAdminUserIds();
    cacheTimestamp = now;
    logger.debug({ adminCount: adminUserIdsCache.size }, 'Admin user IDs cache refreshed');
  }

  return adminUserIdsCache;
}

export function isAdmin(userId: number | undefined): boolean {
  if (!userId) {
    return false;
  }

  const adminIds = getAdminUserIds();
  return adminIds.has(userId);
}

export function clearAdminCache(): void {
  adminUserIdsCache = null;
  cacheTimestamp = 0;
}


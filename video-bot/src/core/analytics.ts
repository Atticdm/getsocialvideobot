import { PostHog } from 'posthog-node';
import { config } from './config';
import { logger } from './logger';

type Properties = Record<string, unknown>;

const analyticsGloballyEnabled = config.POSTHOG_ENABLED;
const apiKey = analyticsGloballyEnabled ? config.POSTHOG_API_KEY?.trim() : '';
const host = config.POSTHOG_HOST?.trim() || 'https://us.i.posthog.com';

const baseProperties = {
  appMode: config.APP_MODE,
  env: config.NODE_ENV,
};

let client: PostHog | null = null;
let analyticsEnabled = false;

function disableAnalytics(reason?: unknown): void {
  if (!analyticsEnabled && !client) return;
  analyticsEnabled = false;
  if (reason) {
    logger.warn(
      {
        reason: reason instanceof Error ? reason.message : reason,
      },
      'Disabling PostHog analytics due to error'
    );
  } else {
    logger.warn('Disabling PostHog analytics');
  }
  const current = client;
  client = null;
  if (current) {
    void current.shutdown().catch((error) => {
      logger.debug({ error }, 'PostHog shutdown after disable failed');
    });
  }
}

if (!analyticsGloballyEnabled) {
  logger.info('PostHog analytics disabled via configuration');
} else if (apiKey) {
  try {
    client = new PostHog(apiKey, {
      host,
      flushAt: 1,
      flushInterval: 1000,
    });
    client.on('error', (error: unknown) => {
      disableAnalytics(error);
    });
    analyticsEnabled = true;
    logger.info({ host }, 'PostHog analytics enabled');
  } catch (error) {
    logger.warn({ error }, 'Failed to initialize PostHog analytics');
    disableAnalytics(error);
  }
} else if (analyticsGloballyEnabled) {
  logger.info('PostHog analytics disabled: API key missing or empty');
}

function cleanProperties(properties?: Properties): Properties {
  const merged = { ...baseProperties, ...(properties || {}) };
  const entries = Object.entries(merged).filter(([, value]) => value !== undefined && value !== null);
  return entries.length ? Object.fromEntries(entries) : {};
}

function emit(event: string, distinctId: string, properties?: Properties): void {
  if (!analyticsEnabled || !client) return;
  try {
    client.capture({
      distinctId,
      event,
      properties: cleanProperties(properties),
    });
  } catch (error) {
    disableAnalytics(error);
  }
}

export function trackUserEvent(
  event: string,
  userId: number | string | undefined,
  properties?: Properties
): void {
  if (!analyticsEnabled || !client) return;
  const distinctId = typeof userId === 'number' ? String(userId) : userId || 'anonymous';
  emit(event, distinctId, properties);
}

export function trackSystemEvent(event: string, properties?: Properties): void {
  if (!analyticsEnabled || !client) return;
  emit(event, 'video-bot', properties);
}

let shuttingDown = false;

export async function shutdownAnalytics(): Promise<void> {
  if (!client || shuttingDown) return;
  shuttingDown = true;
  try {
    await client.shutdown();
  } catch (error) {
    logger.warn({ error }, 'Failed to shutdown PostHog client');
  } finally {
    client = null;
    analyticsEnabled = false;
    shuttingDown = false;
  }
}

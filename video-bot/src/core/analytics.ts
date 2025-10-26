import { PostHog } from 'posthog-node';
import { config } from './config';
import { logger } from './logger';

type Properties = Record<string, unknown>;

const apiKey = config.POSTHOG_API_KEY?.trim();
const host = config.POSTHOG_HOST?.trim() || 'https://us.i.posthog.com';

const baseProperties = {
  appMode: config.APP_MODE,
  env: config.NODE_ENV,
};

let client: PostHog | null = null;

if (apiKey) {
  try {
    client = new PostHog(apiKey, {
      host,
      flushAt: 1,
      flushInterval: 1000,
    });
    logger.info({ host }, 'PostHog analytics enabled');
  } catch (error) {
    logger.warn({ error }, 'Failed to initialize PostHog analytics');
  }
}

function cleanProperties(properties?: Properties): Properties {
  const merged = { ...baseProperties, ...(properties || {}) };
  const entries = Object.entries(merged).filter(([, value]) => value !== undefined && value !== null);
  return entries.length ? Object.fromEntries(entries) : {};
}

function emit(event: string, distinctId: string, properties?: Properties): void {
  if (!client) return;
  try {
    client.capture({
      distinctId,
      event,
      properties: cleanProperties(properties),
    });
  } catch (error) {
    logger.warn({ error, event }, 'Failed to emit PostHog event');
  }
}

export function trackUserEvent(
  event: string,
  userId: number | string | undefined,
  properties?: Properties
): void {
  const distinctId = typeof userId === 'number' ? String(userId) : userId || 'anonymous';
  emit(event, distinctId, properties);
}

export function trackSystemEvent(event: string, properties?: Properties): void {
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
  }
}

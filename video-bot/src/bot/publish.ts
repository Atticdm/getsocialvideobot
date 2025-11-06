import { randomBytes } from 'crypto';
import type { Telegram } from 'telegraf';
import type { User } from '@telegraf/types';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { trackUserEvent } from '../core/analytics';

const CANDIDATE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface PublishCandidate {
  token: string;
  ownerId: number;
  fileId: string;
  fileName?: string;
  originalUrl?: string;
  fileType?: 'document' | 'video';
  createdAt: number;
}

interface PublishCandidateOptions {
  ownerId: number;
  fileId: string;
  fileName?: string;
  originalUrl?: string;
  fileType?: 'document' | 'video';
}

const candidates = new Map<string, PublishCandidate>();

function cleanupExpiredCandidates(): void {
  const now = Date.now();
  for (const [token, candidate] of candidates.entries()) {
    if (now - candidate.createdAt > CANDIDATE_TTL_MS) {
      candidates.delete(token);
    }
  }
}

export function isArenaPublishingEnabled(): boolean {
  return Boolean(config.ARENA_CHANNEL_ID);
}

export function getArenaDisplayName(): string {
  if (config.ARENA_CHANNEL_URL) return config.ARENA_CHANNEL_URL;
  if (config.ARENA_CHANNEL_ID?.startsWith('@')) return config.ARENA_CHANNEL_ID;
  if (config.ARENA_CHANNEL_ID) return 'канал';
  return 'канал';
}

export function registerPublishCandidate(options: PublishCandidateOptions): string {
  cleanupExpiredCandidates();
  const token = randomBytes(8).toString('hex');
  candidates.set(token, {
    token,
    createdAt: Date.now(),
    ...options,
  });
  return token;
}

export function getPublishCandidate(token: string): PublishCandidate | undefined {
  cleanupExpiredCandidates();
  return candidates.get(token);
}

export function removePublishCandidate(token: string): void {
  candidates.delete(token);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildCaptionText(originalUrl: string | undefined): string {
  if (!originalUrl) {
    return '🔗 Источник недоступен';
  }
  const safeUrl = escapeHtml(originalUrl);
  return `<a href="${safeUrl}">🔗 Источник</a>`;
}

export type PublishResult =
  | { ok: true }
  | { ok: false; reason: 'disabled' | 'not_found' | 'forbidden' | 'send_failed' };

export async function publishCandidateToken(
  token: string,
  telegram: Telegram,
  requester: User | undefined
): Promise<PublishResult> {
  if (!config.ARENA_CHANNEL_ID) {
    trackUserEvent('arena.publish_attempt', requester?.id, {
      success: false,
      reason: 'disabled',
    });
    return { ok: false, reason: 'disabled' };
  }

  const candidate = getPublishCandidate(token);
  if (!candidate) {
    trackUserEvent('arena.publish_attempt', requester?.id, {
      success: false,
      reason: 'not_found',
    });
    return { ok: false, reason: 'not_found' };
  }

  if (requester?.id !== candidate.ownerId) {
    trackUserEvent('arena.publish_attempt', requester?.id, {
      success: false,
      reason: 'forbidden',
    });
    return { ok: false, reason: 'forbidden' };
  }

  try {
    const caption = buildCaptionText(candidate.originalUrl);
    if (candidate.fileType === 'video') {
      await telegram.sendVideo(config.ARENA_CHANNEL_ID, candidate.fileId, {
        caption,
        parse_mode: 'HTML',
        disable_notification: false,
        supports_streaming: true,
      });
    } else {
      await telegram.sendDocument(config.ARENA_CHANNEL_ID, candidate.fileId, {
        caption,
        parse_mode: 'HTML',
        disable_notification: false,
      });
    }
    removePublishCandidate(token);
    trackUserEvent('arena.publish_attempt', requester?.id, {
      success: true,
    });
    return { ok: true };
  } catch (error) {
    logger.error(
      {
        error,
        token,
        channelId: config.ARENA_CHANNEL_ID,
      },
      'Failed to publish candidate to Arena channel'
    );
    trackUserEvent('arena.publish_attempt', requester?.id, {
      success: false,
      reason: 'send_failed',
    });
    return { ok: false, reason: 'send_failed' };
  }
}

interface DirectArenaPublishOptions {
  filePath: string;
  fileName: string;
  originalUrl?: string;
  telegram: Telegram;
}

export async function publishFileDirectlyToArena(
  options: DirectArenaPublishOptions
): Promise<boolean> {
  if (!config.ARENA_CHANNEL_ID) return false;
  try {
    const caption = buildCaptionText(options.originalUrl);
    await options.telegram.sendDocument(
      config.ARENA_CHANNEL_ID,
      { source: options.filePath, filename: options.fileName },
      { caption, parse_mode: 'HTML' }
    );
    return true;
  } catch (error) {
    logger.error(
      { error, filePath: options.filePath, channelId: config.ARENA_CHANNEL_ID },
      'Failed to publish file directly to Arena'
    );
    return false;
  }
}

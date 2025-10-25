import { randomBytes } from 'crypto';
import type { Telegram } from 'telegraf';
import type { User } from '@telegraf/types';
import { config } from '../core/config';
import { logger } from '../core/logger';

const CANDIDATE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface PublishCandidate {
  token: string;
  ownerId: number;
  fileId: string;
  fileName?: string;
  originalUrl?: string;
  createdAt: number;
}

interface PublishCandidateOptions {
  ownerId: number;
  fileId: string;
  fileName?: string;
  originalUrl?: string;
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

function formatRequesterName(user?: User): string | undefined {
  if (!user) return undefined;
  if (user.username) return `@${user.username}`;
  const parts = [user.first_name, user.last_name].filter(Boolean);
  if (parts.length) {
    return parts.join(' ');
  }
  return undefined;
}

function buildCaption(candidate: PublishCandidate, requester?: User): string {
  const lines: string[] = [];
  const displayName = getArenaDisplayName();
  lines.push(`📣 Публикация через ${displayName}`);
  if (candidate.originalUrl) {
    lines.push(`🔗 Источник: ${candidate.originalUrl}`);
  }
  const requesterName = formatRequesterName(requester);
  if (requesterName) {
    lines.push(`🙋 Автор: ${requesterName}`);
  }
  lines.push('#reels #arena');
  return lines.join('\n');
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
    return { ok: false, reason: 'disabled' };
  }

  const candidate = getPublishCandidate(token);
  if (!candidate) {
    return { ok: false, reason: 'not_found' };
  }

  if (requester?.id !== candidate.ownerId) {
    return { ok: false, reason: 'forbidden' };
  }

  try {
    const caption = buildCaption(candidate, requester);
    await telegram.sendDocument(config.ARENA_CHANNEL_ID, candidate.fileId, {
      caption,
      disable_notification: false,
    });
    removePublishCandidate(token);
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
    return { ok: false, reason: 'send_failed' };
  }
}

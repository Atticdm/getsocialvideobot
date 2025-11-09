import * as fs from 'fs-extra';
import * as path from 'path';
import { logger } from '../core/logger';
import type { VideoInfo } from './types';
import { getVideoMetadata } from '../core/media';

export async function findDownloadedFile(outDir: string): Promise<string | null> {
  try {
    const files = await fs.readdir(outDir);
    // Broaden the search to include audio files in case of merge failure, to prevent crashes.
    const candidates = files.filter((f) => ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4a', '.mp3', '.opus'].includes(path.extname(f).toLowerCase()));
    if (candidates.length === 0) {
        logger.warn('No media files found in session directory', { outDir });
        return null;
    }
    const stats = await Promise.all(candidates.map(async (f) => {
      const p = path.join(outDir, f);
      const st = await fs.stat(p);
      return { p, mtime: st.mtime };
    }));
    stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return stats[0]?.p || null;
  } catch (e) {
    logger.error('findDownloadedFile failed', { error: e, outDir });
    return null;
  }
}

export async function parseVideoInfoFromPath(filePath: string, url: string): Promise<VideoInfo> {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName);
  const base = fileName.slice(0, -ext.length);
  const parts = base.split('.');
  const id = parts.length > 1 ? parts[parts.length - 1] || 'unknown' : 'unknown';
  let title = parts.length > 1 ? base.replace(`.${id}`, '') : base;
  if (title.length > 100) title = title.slice(0, 100) + '...';
  const metadata = await getVideoMetadata(filePath);
  return { id, title, url, duration: metadata.duration, width: metadata.width, height: metadata.height };
}

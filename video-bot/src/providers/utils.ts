import * as fs from 'fs-extra';
import * as path from 'path';
import { VideoInfo } from './types';

export function parseVideoInfoFromPath(filePath: string, url: string): VideoInfo {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName);
  const base = fileName.slice(0, -ext.length);
  const parts = base.split('.');
  const id = parts[parts.length - 1] || 'unknown';
  let title = base.replace(`.${id}`, '');
  if (title.length > 100) title = title.slice(0, 100) + '...';
  return { id, title, url };
}

export async function findDownloadedFile(outDir: string): Promise<string | null> {
  const files = await fs.readdir(outDir);
  const candidates = files.filter((f) => ['.mp4', '.mkv', '.webm', '.mov'].includes(path.extname(f).toLowerCase()));
  if (candidates.length === 0) return null;
  const stats = await Promise.all(candidates.map(async (f) => {
    const p = path.join(outDir, f);
    const st = await fs.stat(p);
    return { p, mtime: st.mtime };
  }));
  stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return stats[0]?.p || null;
}
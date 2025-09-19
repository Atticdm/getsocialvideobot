import * as fs from 'fs-extra';
import * as path from 'path';
import { logger } from '../core/logger';

export async function writeCookiesFile(b64: string | undefined, outDir: string, fileName: string): Promise<string | undefined> {
  if (!b64) return undefined;
  try {
    const buf = Buffer.from(b64, 'base64');
    const cookiesPath = path.join(outDir, fileName);
    await fs.writeFile(cookiesPath, buf);
    logger.info('Cookies written', { cookiesPath });
    return cookiesPath;
  } catch (e) {
    logger.warn('Failed to write cookies', { error: e });
    return undefined;
  }
}


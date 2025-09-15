import { isFacebookUrl } from './facebook/detect';
import { downloadFacebookVideo } from './facebook/download';
import { isInstagramUrl } from './instagram/detect';
import { downloadInstagramVideo } from './instagram/download';
import { DownloadResult } from './types';

export type ProviderName = 'facebook' | 'instagram';

export interface Provider {
  download(url: string, outDir: string): Promise<DownloadResult>;
}

export function detectProvider(url: string): ProviderName | null {
  if (isFacebookUrl(url)) {
    return 'facebook';
  }
  if (isInstagramUrl(url)) {
    return 'instagram';
  }
  return null;
}

export function getProvider(name: ProviderName): Provider {
  switch (name) {
    case 'facebook':
      return {
        download: downloadFacebookVideo,
      };
    case 'instagram':
      return {
        download: downloadInstagramVideo,
      };
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}

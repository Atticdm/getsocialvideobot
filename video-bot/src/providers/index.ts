import { isFacebookUrl } from './facebook/detect';
import { downloadFacebookVideo } from './facebook/download';
import { isInstagramUrl } from './instagram/detect';
import { downloadInstagramVideo } from './instagram/download';
import { isLinkedInUrl } from './linkedin/detect';
import { downloadLinkedInVideo } from './linkedin/download';
import { isYouTubeUrl } from './youtube/detect';
import { downloadYouTubeVideo } from './youtube/download';
import { DownloadResult } from './types';

export type ProviderName = 'facebook' | 'instagram' | 'linkedin' | 'youtube';

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
  if (isLinkedInUrl(url)) {
    return 'linkedin';
  }
  if (isYouTubeUrl(url)) {
    return 'youtube';
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
    case 'linkedin':
      return {
        download: downloadLinkedInVideo,
      };
    case 'youtube':
      return {
        download: downloadYouTubeVideo,
      };
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}

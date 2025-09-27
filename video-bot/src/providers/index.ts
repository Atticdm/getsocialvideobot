import { isFacebookUrl } from './facebook/detect';
import { downloadFacebookVideo, fetchFacebookMetadata } from './facebook/download';
import { isInstagramUrl } from './instagram/detect';
import { downloadInstagramVideo, fetchInstagramMetadata } from './instagram/download';
import { isLinkedInUrl } from './linkedin/detect';
import { downloadLinkedInVideo, fetchLinkedInMetadata } from './linkedin/download';
import { isYouTubeUrl } from './youtube/detect';
import { downloadYouTubeVideo, fetchYouTubeMetadata } from './youtube/download';
import { DownloadResult, VideoMetadata } from './types';

export type ProviderName = 'facebook' | 'instagram' | 'linkedin' | 'youtube';

export interface Provider {
  download(url: string, outDir: string): Promise<DownloadResult>;
  metadata(url: string): Promise<VideoMetadata>;
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
        metadata: fetchFacebookMetadata,
      };
    case 'instagram':
      return {
        download: downloadInstagramVideo,
        metadata: fetchInstagramMetadata,
      };
    case 'linkedin':
      return {
        download: downloadLinkedInVideo,
        metadata: fetchLinkedInMetadata,
      };
    case 'youtube':
      return {
        download: downloadYouTubeVideo,
        metadata: fetchYouTubeMetadata,
      };
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}

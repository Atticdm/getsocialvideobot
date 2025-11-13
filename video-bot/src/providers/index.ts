import { isFacebookUrl } from './facebook/detect';
import { downloadFacebookVideo, fetchFacebookMetadata } from './facebook/download';
import { isInstagramUrl } from './instagram/detect';
import { downloadInstagramVideo, fetchInstagramMetadata } from './instagram/download';
import { isLinkedInUrl } from './linkedin/detect';
import { downloadLinkedInVideo, fetchLinkedInMetadata } from './linkedin/download';
import { isYouTubeUrl } from './youtube/detect';
import { downloadYouTubeVideo, fetchYouTubeMetadata } from './youtube/download';
import { isTikTokUrl } from './tiktok/detect';
import { downloadTikTokVideo, fetchTikTokMetadata } from './tiktok/download';
import { isSoraUrl } from './sora/detect';
import { downloadSoraVideo, fetchSoraMetadata } from './sora/download';
import { isVkUrl } from './vk/detect';
import { downloadVkVideo, fetchVkMetadata } from './vk/download';
import { DownloadResult, VideoMetadata } from './types';

export type ProviderName = 'facebook' | 'instagram' | 'linkedin' | 'youtube' | 'tiktok' | 'sora' | 'vk';

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
  if (isTikTokUrl(url)) {
    return 'tiktok';
  }
  if (isSoraUrl(url)) {
    return 'sora';
  }
  if (isVkUrl(url)) {
    return 'vk';
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
    case 'tiktok':
      return {
        download: downloadTikTokVideo,
        metadata: fetchTikTokMetadata,
      };
    case 'sora':
      return {
        download: downloadSoraVideo,
        metadata: fetchSoraMetadata,
      };
    case 'vk':
      return {
        download: downloadVkVideo,
        metadata: fetchVkMetadata,
      };
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}

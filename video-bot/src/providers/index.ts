import { isFacebookUrl } from './facebook/detect';
import { downloadFacebookVideo } from './facebook/download';
import { DownloadResult } from './facebook/types';

export type ProviderName = 'facebook';

export interface Provider {
  download(url: string, outDir: string): Promise<DownloadResult>;
}

export function detectProvider(url: string): ProviderName | null {
  if (isFacebookUrl(url)) {
    return 'facebook';
  }
  return null;
}

export function getProvider(name: ProviderName): Provider {
  switch (name) {
    case 'facebook':
      return {
        download: downloadFacebookVideo,
      };
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}

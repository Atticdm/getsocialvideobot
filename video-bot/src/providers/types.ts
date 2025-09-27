export interface VideoInfo {
  id: string;
  title: string;
  url: string;
  duration?: number | undefined;
  size?: number | undefined;
}

export interface DownloadResult {
  filePath: string;
  videoInfo: VideoInfo;
}

export interface VideoMetadata {
  downloadUrl: string;
  title: string;
  duration?: number;
  fileSize?: number;
  thumbnail?: string;
}

export interface FacebookVideoInfo {
  id: string;
  title: string;
  url: string;
  duration?: number | undefined;
  size?: number | undefined;
}

export interface DownloadResult {
  filePath: string;
  videoInfo: FacebookVideoInfo;
}

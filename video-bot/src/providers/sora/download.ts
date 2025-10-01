import * as fs from 'fs-extra';
import * as path from 'path';
import { chromium } from 'playwright-core';
import { logger } from '../../core/logger';
import { ERROR_CODES, AppError } from '../../core/errors';
import { VideoInfo, DownloadResult, VideoMetadata } from '../types';
import { config } from '../../core/config';

function extractVideoId(url: string): string {
  try {
    // Format: https://sora.chatgpt.com/p/s_xxxxxxxx
    const match = url.match(/sora\.chatgpt\.com\/p\/(s_[a-f0-9]+)/);
    return match && match[1] ? match[1] : '';
  } catch {
    return '';
  }
}

async function parseCookiesFromB64(): Promise<any[] | null> {
  const canUseCookies = !!config['SORA_COOKIES_B64'] && !config['SKIP_COOKIES'];
  if (!canUseCookies) return null;
  
  try {
    const buf = Buffer.from(config['SORA_COOKIES_B64'], 'base64');
    const content = buf.toString('utf-8');
    const cookies: any[] = [];
    
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const parts = trimmed.split('\t');
      if (parts.length >= 7 && parts[5] && parts[6]) {
        cookies.push({
          name: parts[5],
          value: parts[6],
          domain: parts[0] || '',
          path: parts[2] || '/',
          expires: parseInt(parts[4] || '0', 10) || -1,
          httpOnly: false,
          secure: parts[3] === 'TRUE',
        });
      }
    }
    
    logger.info('Parsed Sora cookies for Playwright', { count: cookies.length });
    return cookies.length > 0 ? cookies : null;
  } catch (error) {
    logger.warn('Failed to parse Sora cookies', { error });
    return null;
  }
}

async function fetchVideoUrlWithPlaywright(url: string): Promise<string | null> {
  logger.info('Using Playwright to fetch Sora video', { url });
  let browser = null;
  
  try {
    const cookies = await parseCookiesFromB64();
    if (!cookies) {
      logger.warn('No cookies available - Cloudflare will likely block the request');
    }
    
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    
    if (cookies) {
      await context.addCookies(cookies);
      logger.info('Cookies added to Playwright context');
    }
    
    const page = await context.newPage();
    let videoUrl: string | null = null;
    
    // Intercept network requests to find video URL
    page.on('request', (request) => {
      const reqUrl = request.url();
      if (reqUrl.includes('.mp4') || reqUrl.includes('.m3u8')) {
        logger.info('Found potential video URL in network request', { url: reqUrl });
        if (!videoUrl) videoUrl = reqUrl;
      }
    });
    
    logger.info('Navigating to Sora page with Playwright');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    
    // Wait a bit for video to load
    await page.waitForTimeout(3000);
    
    // Try to find video element
    const videoElement = await page.$('video');
    if (videoElement) {
      const src = await videoElement.getAttribute('src');
      if (src && src.startsWith('http')) {
        logger.info('Found video source in video element', { src });
        videoUrl = src;
      }
      
      // Try source elements
      const sources = await page.$$('video source');
      for (const source of sources) {
        const srcAttr = await source.getAttribute('src');
        if (srcAttr && srcAttr.startsWith('http')) {
          logger.info('Found video source in source element', { src: srcAttr });
          videoUrl = srcAttr;
          break;
        }
      }
    }
    
    await browser.close();
    return videoUrl;
  } catch (error: any) {
    if (browser) await browser.close().catch(() => {});
    logger.error('Playwright failed to fetch Sora video', { url, error: error.message });
    return null;
  }
}

async function downloadVideoFile(videoUrl: string, outputPath: string): Promise<void> {
  try {
    logger.info('Downloading video file', { videoUrl, outputPath });
    
    const response = await fetch(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://sora.chatgpt.com/',
      },
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const buffer = await response.arrayBuffer();
    await fs.writeFile(outputPath, Buffer.from(buffer));
    logger.info('Video file downloaded successfully', { outputPath, size: buffer.byteLength });
  } catch (error: any) {
    logger.error('Failed to download video file', { videoUrl, error: error.message });
    throw new AppError(ERROR_CODES.ERR_FETCH_FAILED, 'Failed to download video file', { videoUrl, error: error.message });
  }
}

export async function downloadSoraVideo(url: string, outDir: string): Promise<DownloadResult> {
  logger.info('Starting Sora video download with Playwright', { url, outDir });
  
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new AppError(ERROR_CODES.ERR_UNSUPPORTED_URL, 'Invalid Sora URL format', { url });
  }
  
  try {
    // Use Playwright to bypass Cloudflare and get video URL
    const videoUrl = await fetchVideoUrlWithPlaywright(url);
    
    if (!videoUrl) {
      throw new AppError(
        ERROR_CODES.ERR_FETCH_FAILED,
        config['SORA_COOKIES_B64'] 
          ? 'Could not extract video URL. Cookies may be expired or the video may be unavailable.'
          : 'Could not extract video URL. Please set SORA_COOKIES_B64 with your authentication cookies.',
        { url }
      );
    }
    
    // Download the video file
    const outputPath = path.join(outDir, `sora_${videoId}.mp4`);
    await downloadVideoFile(videoUrl, outputPath);
    
    // Verify file was created
    const exists = await fs.pathExists(outputPath);
    if (!exists) {
      throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Video file was not created', { url, outputPath });
    }
    
    const videoInfo: VideoInfo = {
      id: videoId,
      title: `Sora Video ${videoId}`,
      url,
    };
    
    logger.info('Sora video downloaded successfully', { url, filePath: outputPath, videoInfo });
    return { filePath: outputPath, videoInfo };
    
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Unexpected error during Sora download', { error, url, outDir });
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Unexpected error during Sora download', { url, originalError: error });
  }
}

export async function fetchSoraMetadata(url: string): Promise<VideoMetadata> {
  logger.info('Fetching Sora metadata with Playwright', { url });
  
  try {
    const videoUrl = await fetchVideoUrlWithPlaywright(url);
    
    if (!videoUrl) {
      throw new AppError(
        ERROR_CODES.ERR_FETCH_FAILED,
        'Could not extract video metadata. Please ensure SORA_COOKIES_B64 is set.',
        { url }
      );
    }
    
    const videoId = extractVideoId(url);
    
    return {
      downloadUrl: videoUrl,
      title: `Sora Video ${videoId}`,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed to fetch Sora metadata', { url, originalError: error });
  }
}


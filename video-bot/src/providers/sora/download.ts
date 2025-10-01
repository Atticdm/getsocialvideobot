import * as fs from 'fs-extra';
import * as path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../../core/logger';
import { ERROR_CODES, AppError } from '../../core/errors';
import { VideoInfo, DownloadResult, VideoMetadata } from '../types';

function extractVideoId(url: string): string {
  try {
    // Format: https://sora.chatgpt.com/p/s_xxxxxxxx
    const match = url.match(/sora\.chatgpt\.com\/p\/(s_[a-f0-9]+)/);
    return match && match[1] ? match[1] : '';
  } catch {
    return '';
  }
}

async function fetchPageData(url: string): Promise<string> {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'max-age=0',
      },
      timeout: 30000,
      maxRedirects: 5,
    });
    return response.data;
  } catch (error: any) {
    logger.error('Failed to fetch Sora page', { url, error: error.message });
    throw new AppError(ERROR_CODES.ERR_FETCH_FAILED, 'Failed to fetch Sora page', { url, error: error.message });
  }
}

function extractVideoUrlFromHtml(html: string, url: string): string | null {
  try {
    const $ = cheerio.load(html);
    
    // Try to find video in various script tags with Next.js data
    let foundUrl: string | null = null;
    $('script').each((_, element) => {
      if (foundUrl) return false; // Stop if already found
      const scriptContent = $(element).html();
      if (!scriptContent) return true; // Continue iteration
      
      // Look for video URLs in JSON data
      const videoUrlMatch = scriptContent.match(/"(https:\/\/[^"]*\.mp4[^"]*)"/g);
      if (videoUrlMatch && videoUrlMatch.length > 0) {
        // Clean up the URL
        const cleanUrl = videoUrlMatch[0].replace(/"/g, '').replace(/\\u002F/g, '/');
        logger.info('Found video URL in script tag', { url: cleanUrl });
        foundUrl = cleanUrl;
        return false; // Stop iteration
      }
      return true; // Continue iteration
    });
    
    if (foundUrl) return foundUrl;
    
    // Try to find video tag directly
    const videoSrc = $('video source').attr('src') || $('video').attr('src');
    if (videoSrc) {
      logger.info('Found video URL in video tag', { url: videoSrc });
      return videoSrc;
    }
    
    // Try to find in meta tags
    const metaVideo = $('meta[property="og:video"]').attr('content') || 
                     $('meta[property="og:video:url"]').attr('content');
    if (metaVideo) {
      logger.info('Found video URL in meta tags', { url: metaVideo });
      return metaVideo;
    }
    
    logger.warn('No video URL found in HTML', { pageUrl: url });
    return null;
  } catch (error: any) {
    logger.error('Failed to parse Sora HTML', { url, error: error.message });
    return null;
  }
}

async function downloadVideoFile(videoUrl: string, outputPath: string): Promise<void> {
  try {
    logger.info('Downloading video from URL', { videoUrl, outputPath });
    
    const response = await axios.get(videoUrl, {
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://sora.chatgpt.com/',
      },
      timeout: 300000, // 5 minutes
    });
    
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error: any) {
    logger.error('Failed to download video file', { videoUrl, error: error.message });
    throw new AppError(ERROR_CODES.ERR_FETCH_FAILED, 'Failed to download video file', { videoUrl, error: error.message });
  }
}

function parseVideoInfoFromPath(url: string, videoId: string): VideoInfo {
  return {
    id: videoId,
    title: `Sora Video ${videoId}`,
    url,
  };
}

export async function downloadSoraVideo(url: string, outDir: string): Promise<DownloadResult> {
  logger.info('Starting Sora video download', { url, outDir });
  
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new AppError(ERROR_CODES.ERR_UNSUPPORTED_URL, 'Invalid Sora URL format', { url });
  }
  
  try {
    // Fetch the page HTML
    const html = await fetchPageData(url);
    
    // Check if we got Cloudflare challenge page
    if (html.includes('Just a moment...') || html.includes('challenge-platform')) {
      logger.warn('Cloudflare protection detected, trying alternative method');
      throw new AppError(
        ERROR_CODES.ERR_FETCH_FAILED, 
        'Sora page is protected by Cloudflare. Please try again or use a browser to access the video.',
        { url }
      );
    }
    
    // Extract video URL from HTML
    const videoUrl = extractVideoUrlFromHtml(html, url);
    if (!videoUrl) {
      throw new AppError(
        ERROR_CODES.ERR_INTERNAL, 
        'Could not find video URL in Sora page. The page structure may have changed.',
        { url }
      );
    }
    
    // Download the video
    const outputPath = path.join(outDir, `${videoId}.mp4`);
    await downloadVideoFile(videoUrl, outputPath);
    
    // Verify file was created
    const exists = await fs.pathExists(outputPath);
    if (!exists) {
      throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Video file was not created', { url, outputPath });
    }
    
    const videoInfo = parseVideoInfoFromPath(url, videoId);
    logger.info('Sora video downloaded successfully', { url, filePath: outputPath, videoInfo });
    
    return { filePath: outputPath, videoInfo };
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Unexpected error during Sora download', { error, url, outDir });
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Unexpected error during Sora download', { url, originalError: error });
  }
}

export async function fetchSoraMetadata(url: string): Promise<VideoMetadata> {
  logger.info('Fetching Sora metadata', { url });
  
  try {
    const html = await fetchPageData(url);
    
    if (html.includes('Just a moment...') || html.includes('challenge-platform')) {
      throw new AppError(
        ERROR_CODES.ERR_FETCH_FAILED,
        'Sora page is protected by Cloudflare',
        { url }
      );
    }
    
    const videoUrl = extractVideoUrlFromHtml(html, url);
    if (!videoUrl) {
      throw new AppError(
        ERROR_CODES.ERR_INTERNAL,
        'Could not find video URL in Sora page',
        { url }
      );
    }
    
    const $ = cheerio.load(html);
    const title = $('meta[property="og:title"]').attr('content') || 
                 $('title').text() || 
                 'Sora Video';
    const thumbnail = $('meta[property="og:image"]').attr('content');
    
    const metadata: VideoMetadata = {
      downloadUrl: videoUrl,
      title: title.trim(),
    };
    
    if (thumbnail) {
      metadata.thumbnail = thumbnail;
    }
    
    return metadata;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed to fetch Sora metadata', { url, originalError: error });
  }
}


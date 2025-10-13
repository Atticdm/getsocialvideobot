import FormData from 'form-data';
import axios from 'axios';
import * as fs from 'fs-extra';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';

export interface TempServerUploadResult {
  success: boolean;
  fileName: string;
  fileUrl: string;
  fullUrl: string;
  size: number;
}

/**
 * Загружает файл на temp-server (Render)
 * @param filePath Локальный путь к файлу
 * @returns Результат загрузки с URL файла
 */
export async function uploadToTempServer(filePath: string): Promise<TempServerUploadResult> {
  const tempServerUrl = config.TEMP_SERVER_URL;
  const tempServerSecret = config.TEMP_SERVER_SECRET;

  if (!tempServerUrl) {
    throw new Error('TEMP_SERVER_URL is not configured');
  }

  if (!tempServerSecret) {
    throw new Error('TEMP_SERVER_SECRET is not configured');
  }

  const form = new FormData();
  const fileStream = fs.createReadStream(filePath);
  const fileName = path.basename(filePath);

  form.append('video', fileStream, fileName);

  const uploadUrl = `${tempServerUrl.replace(/\/$/, '')}/upload`;

  try {
    logger.debug({ uploadUrl, fileName }, 'Uploading file to temp-server');

    const response = await axios.post<TempServerUploadResult>(uploadUrl, form, {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${tempServerSecret}`,
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 5 * 60 * 1000, // 5 minutes
    });

    const fullUrl = `${tempServerUrl.replace(/\/$/, '')}${response.data.fileUrl}`;

    logger.info({
      fileName: response.data.fileName,
      size: response.data.size,
      fullUrl,
    }, 'File uploaded to temp-server successfully');

    return {
      ...response.data,
      fullUrl,
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      logger.error({
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        message: error.message,
      }, 'Failed to upload file to temp-server');

      throw new Error(
        `Failed to upload to temp-server: ${error.response?.status} ${error.response?.statusText}`
      );
    }

    logger.error({ error }, 'Unexpected error uploading to temp-server');
    throw error;
  }
}

/**
 * Проверяет, настроен ли temp-server
 */
export function isTempServerConfigured(): boolean {
  return !!(config.TEMP_SERVER_URL && config.TEMP_SERVER_SECRET);
}

/**
 * Проверяет доступность temp-server
 */
export async function checkTempServerHealth(): Promise<boolean> {
  const tempServerUrl = config.TEMP_SERVER_URL;

  if (!tempServerUrl) {
    return false;
  }

  try {
    const healthUrl = `${tempServerUrl.replace(/\/$/, '')}/healthz`;
    const response = await axios.get(healthUrl, { timeout: 5000 });
    return response.status === 200 && response.data?.status === 'ok';
  } catch (error) {
    logger.warn({ error, tempServerUrl }, 'Temp server health check failed');
    return false;
  }
}


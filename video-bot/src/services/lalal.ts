import axios, { AxiosResponse, isAxiosError } from 'axios';
import FormData from 'form-data';
import * as fs from 'fs-extra';
import * as path from 'path';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { AppError, ERROR_CODES } from '../core/errors';

const LALAL_API_BASE = 'https://api.lalal.ai';
const LALAL_UPLOAD_ENDPOINT = `${LALAL_API_BASE}/api/upload/`;
const LALAL_SPLIT_ENDPOINT = `${LALAL_API_BASE}/api/split/`;
const LALAL_CHECK_ENDPOINT = `${LALAL_API_BASE}/api/check/`;

const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 60;

interface LalalUploadResponse {
  uuid?: string;
  id?: string;
}

interface LalalCheckResponse {
  result?: Record<
    string,
    {
      task?: {
        state?: string;
        message?: string;
      };
      split?: {
        stem_track?: string;
        back_track?: string;
      };
    }
  >;
}

interface LalalSeparationResult {
  vocalPath: string;
  instrumentalPath: string;
}

export async function separateAudioWithLalal(audioPath: string): Promise<LalalSeparationResult> {
  const apiKey = config.LALAL_API_KEY?.trim();

  if (!apiKey) {
    throw new AppError(
      ERROR_CODES.ERR_INTERNAL,
      'LALAL API key is not configured',
      { hint: 'Set LALAL_API_KEY in environment variables' }
    );
  }

  const exists = await fs.pathExists(audioPath);
  if (!exists) {
    throw new AppError(ERROR_CODES.ERR_FILE_NOT_FOUND, 'Audio file for separation not found', { audioPath });
  }

  logger.info({ audioPath }, 'LALAL: starting separation');

  try {
    const uploadId = await uploadAudio(apiKey, audioPath);
    logger.info({ audioPath, uploadId }, 'LALAL: audio uploaded');

    await triggerSplit(apiKey, uploadId);
    logger.info({ uploadId }, 'LALAL: split job triggered');

    const { stemUrl, backUrl } = await pollForResult(apiKey, uploadId);
    logger.info({ uploadId, stemUrl, backUrl }, 'LALAL: split job completed');

    const { vocalPath, instrumentalPath } = await downloadOutputs(audioPath, stemUrl, backUrl, uploadId);
    logger.info({ uploadId, vocalPath, instrumentalPath }, 'LALAL: separation finished');

    return { vocalPath, instrumentalPath };
  } catch (error) {
    logLalalError(error, audioPath);
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'LALAL.AI separation failed', { cause: normalizeError(error) });
  }
}

async function uploadAudio(apiKey: string, audioPath: string): Promise<string> {
  const fileName = path.basename(audioPath);
  const form = new FormData();
  form.append('file', fs.createReadStream(audioPath), fileName);

  const headers = {
    ...form.getHeaders(),
    Authorization: `license ${apiKey}`,
    'Content-Disposition': `attachment; filename="${fileName}"`,
  };

  try {
    const response: AxiosResponse<LalalUploadResponse> = await axios.post(LALAL_UPLOAD_ENDPOINT, form, {
      headers,
      timeout: 240000,
    });
    const uploadId = response.data?.uuid || response.data?.id;
    if (!uploadId) {
      throw new Error('Upload response missing file id');
    }
    return uploadId;
  } catch (error) {
    logLalalError(error, audioPath, 'upload');
    throw new AppError(
      ERROR_CODES.ERR_INTERNAL,
      'Failed to upload audio to LALAL.AI',
      { cause: normalizeError(error) }
    );
  }
}

async function triggerSplit(apiKey: string, fileId: string): Promise<void> {
  const payload = new URLSearchParams();
  payload.append('params', JSON.stringify([{ id: fileId, stem: 'vocals' }]));

  try {
    await axios.post(
      LALAL_SPLIT_ENDPOINT,
      payload.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `license ${apiKey}`,
        },
        timeout: 120000,
      }
    );
  } catch (error) {
    logLalalError(error, fileId, 'split');
    throw new AppError(
      ERROR_CODES.ERR_INTERNAL,
      'Failed to start separation on LALAL.AI',
      { cause: normalizeError(error) }
    );
  }
}

async function pollForResult(
  apiKey: string,
  fileId: string
): Promise<{ stemUrl: string; backUrl: string }> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await delay(POLL_INTERVAL_MS);
    }

    try {
      const payload = new URLSearchParams();
      payload.append('ids', JSON.stringify([fileId]));

      const response: AxiosResponse<LalalCheckResponse> = await axios.post(
        LALAL_CHECK_ENDPOINT,
        payload.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `license ${apiKey}`,
          },
          timeout: 120000,
        }
      );

      const entry = response.data?.result?.[fileId];
      const state = entry?.task?.state;

      logger.debug({ fileId, attempt, state }, 'LALAL: polling split status');

      if (state === 'success') {
        const stemUrl = entry?.split?.stem_track;
        const backUrl = entry?.split?.back_track;
        if (!stemUrl || !backUrl) {
          throw new Error('Missing split URLs in success response');
        }
        return { stemUrl, backUrl };
      }

      if (state === 'error') {
        const message = entry?.task?.message || 'Unknown LALAL.AI error';
        throw new Error(`LALAL split failed: ${message}`);
      }
    } catch (error) {
      logLalalError(error, fileId, 'poll');
      throw new AppError(
        ERROR_CODES.ERR_INTERNAL,
        'Failed while polling LALAL.AI status',
        { cause: normalizeError(error) }
      );
    }
  }

  throw new AppError(
    ERROR_CODES.ERR_INTERNAL,
    'Timed out waiting for LALAL.AI separation to complete',
    { fileId, attempts: MAX_POLL_ATTEMPTS, intervalMs: POLL_INTERVAL_MS }
  );
}

async function downloadOutputs(
  originalAudioPath: string,
  stemUrl: string,
  backUrl: string,
  fileId: string
): Promise<LalalSeparationResult> {
  const parsed = path.parse(originalAudioPath);
  const baseName = parsed.name || 'output';
  const directory = parsed.dir || path.dirname(originalAudioPath);

  await fs.ensureDir(directory);

  const stemExt = resolveExtension(stemUrl, parsed.ext || '.mp3');
  const backExt = resolveExtension(backUrl, parsed.ext || '.mp3');

  const vocalPath = path.join(directory, `${baseName}.lalal.vocals${stemExt}`);
  const instrumentalPath = path.join(directory, `${baseName}.lalal.instrumental${backExt}`);

  await Promise.all([
    downloadFile(stemUrl, vocalPath, 'vocal', fileId),
    downloadFile(backUrl, instrumentalPath, 'instrumental', fileId),
  ]);

  return { vocalPath, instrumentalPath };
}

async function downloadFile(url: string, targetPath: string, label: string, fileId: string): Promise<void> {
  try {
    logger.debug({ url, targetPath, label, fileId }, 'LALAL: downloading split track');
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 240000,
    });

    await fs.ensureDir(path.dirname(targetPath));

    await new Promise<void>((resolve, reject) => {
      const writeStream = fs.createWriteStream(targetPath);
      response.data.pipe(writeStream);
      response.data.on('error', reject);
      writeStream.on('finish', () => resolve());
      writeStream.on('error', reject);
    });
  } catch (error) {
    logLalalError(error, { url, targetPath, label, fileId }, 'download');
    throw new AppError(
      ERROR_CODES.ERR_INTERNAL,
      `Failed to download ${label} track from LALAL.AI`,
      { cause: normalizeError(error), url, targetPath }
    );
  }
}

function resolveExtension(sourceUrl: string, fallback: string): string {
  try {
    const parsed = new URL(sourceUrl);
    const ext = path.extname(parsed.pathname);
    if (ext) {
      return ext;
    }
  } catch (error) {
    logger.debug({ sourceUrl, error: normalizeError(error) }, 'LALAL: failed to resolve extension from URL');
  }
  return fallback.startsWith('.') ? fallback : `.${fallback}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logLalalError(error: unknown, context: unknown, stage?: string): void {
  const err = normalizeError(error);
  logger.error(
    {
      stage,
      context,
      error: err.message,
      status: err.status,
      code: err.code,
      data: err.data,
      stack: err.stack,
    },
    'LALAL service error'
  );
}

function normalizeError(error: unknown): {
  message: string;
  status?: number;
  code?: unknown;
  data?: unknown;
  stack?: string;
} {
  if (isAxiosError(error)) {
    const normalized: {
      message: string;
      status?: number;
      code?: unknown;
      data?: unknown;
      stack?: string;
    } = { message: error.message };

    if (typeof error.response?.status === 'number') {
      normalized.status = error.response.status;
    }
    if (error.code !== undefined) {
      normalized.code = error.code;
    }
    if (typeof error.response?.data !== 'undefined') {
      normalized.data = error.response.data;
    }
    if (error.stack) {
      normalized.stack = error.stack;
    }

    return normalized;
  }

  if (error instanceof Error) {
    const normalized: { message: string; stack?: string } = { message: error.message };
    if (error.stack) {
      normalized.stack = error.stack;
    }
    return normalized;
  }

  return {
    message: String(error),
  };
}

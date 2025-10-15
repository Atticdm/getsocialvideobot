import axios from 'axios';
import FormData from 'form-data';
import * as fs from 'fs-extra';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { config } from '../core/config';
import { logger } from '../core/logger';

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

interface DubbingJobResponse {
  dubbing_id?: string;
  status?: string;
  state?: string;
  share_url?: string;
  url?: string;
  audio?: { url?: string };
  audio_url?: string;
  download_url?: string;
  result?: { audio_url?: string };
}

function ensureApiKey(): string {
  const apiKey = config.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY is not configured');
  }
  return apiKey;
}

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveAudioUrl(payload: DubbingJobResponse): string | undefined {
  return (
    payload.audio_url ||
    payload.download_url ||
    payload.share_url ||
    payload.url ||
    payload.result?.audio_url ||
    payload.audio?.url
  );
}

async function downloadFile(fileUrl: string, destinationPath: string, apiKey: string): Promise<void> {
  const response = await axios.get(fileUrl, {
    headers: { 'xi-api-key': apiKey },
    responseType: 'stream',
  });

  await fs.ensureDir(path.dirname(destinationPath));

  await new Promise<void>((resolve, reject) => {
    const writer = fs.createWriteStream(destinationPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

export async function dubVideoWithElevenLabs(
  sourceAudioPath: string,
  targetLanguage: string
): Promise<string> {
  const apiKey = ensureApiKey();

  const absoluteSourcePath = path.resolve(sourceAudioPath);
  const exists = await fs.pathExists(absoluteSourcePath);
  if (!exists) {
    throw new Error(`Source audio file not found: ${absoluteSourcePath}`);
  }

  logger.info({ sourceAudioPath: absoluteSourcePath, targetLanguage }, 'Submitting ElevenLabs dubbing job');

  const form = new FormData();
  form.append('mode', 'automatic');
  form.append('target_lang', targetLanguage);
  form.append('num_speakers', '0');
  form.append('file', fs.createReadStream(absoluteSourcePath));

  let jobId: string | undefined;
  try {
    const submitResponse = await axios.post<DubbingJobResponse>(
      `${ELEVENLABS_BASE_URL}/dubbing`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          'xi-api-key': apiKey,
        },
      }
    );

    jobId = submitResponse.data?.dubbing_id;
    if (!jobId) {
      throw new Error(`Unexpected ElevenLabs response (missing dubbing_id): ${JSON.stringify(submitResponse.data)}`);
    }

    logger.info({ jobId }, 'ElevenLabs dubbing job submitted');
  } catch (error) {
    logger.error({ error }, 'Failed to submit ElevenLabs dubbing job');
    throw error;
  }

  const statusUrl = `${ELEVENLABS_BASE_URL}/dubbing/${jobId}`;
  const start = Date.now();
  let lastStatus: string | undefined;
  let jobPayload: DubbingJobResponse | undefined;

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    try {
      const statusResponse = await axios.get<DubbingJobResponse>(statusUrl, {
        headers: { 'xi-api-key': apiKey },
      });
      jobPayload = statusResponse.data;
      lastStatus = jobPayload.status || jobPayload.state;

      logger.debug({ jobId, status: lastStatus }, 'ElevenLabs dubbing job status polled');

      if (lastStatus && lastStatus.toLowerCase() === 'dubbed') {
        break;
      }
      if (lastStatus && ['failed', 'error', 'cancelled', 'canceled'].includes(lastStatus.toLowerCase())) {
        throw new Error(`ElevenLabs dubbing job failed with status: ${lastStatus}`);
      }
    } catch (error) {
      logger.warn({ error, jobId }, 'Failed to poll ElevenLabs job status, retrying');
    }

    await wait(POLL_INTERVAL_MS);
  }

  if (!jobPayload || !lastStatus || lastStatus.toLowerCase() !== 'dubbed') {
    throw new Error(`Timed out waiting for ElevenLabs dubbing job ${jobId}`);
  }

  const audioUrl = resolveAudioUrl(jobPayload);
  if (!audioUrl) {
    throw new Error(`ElevenLabs dubbing job ${jobId} completed but no audio URL was provided`);
  }

  const outputDir = path.join(config.DOWNLOAD_DIR, 'elevenlabs');
  const outputPath = path.join(outputDir, `dubbed-${randomUUID()}.mp3`);

  logger.info({ jobId, audioUrl, outputPath }, 'Downloading ElevenLabs dubbed audio');

  try {
    await downloadFile(audioUrl, outputPath, apiKey);
    logger.info({ outputPath }, 'ElevenLabs dubbed audio downloaded');
    return outputPath;
  } catch (error) {
    logger.error({ error, jobId, audioUrl }, 'Failed to download ElevenLabs dubbed audio');
    throw error;
  }
}

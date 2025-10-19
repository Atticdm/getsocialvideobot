import axios from 'axios';
import FormData from 'form-data';
import * as fs from 'fs-extra';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { config } from '../core/config';
import { logger } from '../core/logger';
import type { VoicePreset } from '../types/voice';

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

export function getVoiceIdForPreset(preset: VoicePreset['id']): string | undefined {
  const trimmed = (value: string | undefined) => (value && value.trim().length ? value.trim() : undefined);
  if (preset === 'terminator-ru') return trimmed(config.ELEVENLABS_TERMINATOR_VOICE_RU);
  if (preset === 'terminator-en') return trimmed(config.ELEVENLABS_TERMINATOR_VOICE_EN);
  return undefined;
}

export async function dubVideoWithElevenLabs(
  sourceAudioPath: string,
  targetLanguage: string,
  sourceLanguage?: string,
  voiceIdOverride?: string
): Promise<string> {
  const apiKey = ensureApiKey();

  const absoluteSourcePath = path.resolve(sourceAudioPath);
  const exists = await fs.pathExists(absoluteSourcePath);
  if (!exists) {
    throw new Error(`Source audio file not found: ${absoluteSourcePath}`);
  }

  logger.info({ sourceAudioPath: absoluteSourcePath, targetLanguage, voiceIdOverride }, 'Submitting ElevenLabs dubbing job');

  const form = new FormData();
  form.append('mode', 'automatic');
  form.append('target_lang', targetLanguage);
  if (sourceLanguage) {
    form.append('source_lang', sourceLanguage);
  }
  form.append('num_speakers', '0');
  form.append('disable_voice_cloning', 'false');
  form.append('dubbing_studio', 'false');
  form.append('drop_background_audio', 'false');
  form.append('name', `Dub-${randomUUID()}`);
  if (voiceIdOverride) {
    form.append('voice_id', voiceIdOverride);
  }
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
    const axiosError = error as any;
    logger.error({
      error,
      responseData: axiosError?.response?.data,
      status: axiosError?.response?.status,
    }, 'Failed to submit ElevenLabs dubbing job');
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

  const outputDir = path.join(config.DOWNLOAD_DIR, 'elevenlabs');
  const outputPath = path.join(outputDir, `dubbed-${randomUUID()}.mp3`);

  try {
    const audioResponse = await axios.get<ArrayBuffer>(
      `${ELEVENLABS_BASE_URL}/dubbing/${jobId}/audio/${targetLanguage}`,
      {
        headers: { 'xi-api-key': apiKey },
        responseType: 'arraybuffer',
      }
    );

    await fs.ensureDir(path.dirname(outputPath));
    await fs.writeFile(outputPath, Buffer.from(audioResponse.data));

    logger.info({ outputPath }, 'ElevenLabs dubbed audio downloaded');
    return outputPath;
  } catch (error) {
    logger.error({ error, jobId }, 'Failed to download ElevenLabs dubbed audio');
    throw error;
  }
}

export async function synthesizeWithElevenLabsTTS(
  text: string,
  voiceId: string,
  outputPath: string,
  modelId: string = config.ELEVENLABS_TTS_MODEL_ID
): Promise<string> {
  const apiKey = ensureApiKey();
  const payload = {
    text: text && text.trim().length ? text : '.',
    model_id: modelId,
  };

  try {
    const response = await axios.post<ArrayBuffer>(
      `${ELEVENLABS_BASE_URL}/text-to-speech/${voiceId}`,
      payload,
      {
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer',
      }
    );

    await fs.ensureDir(path.dirname(outputPath));
    await fs.writeFile(outputPath, Buffer.from(response.data));
    return outputPath;
  } catch (error) {
    logger.error({ error, voiceId }, 'Failed to synthesize ElevenLabs TTS audio');
    throw error;
  }
}

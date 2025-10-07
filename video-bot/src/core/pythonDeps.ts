import * as path from 'path';
import { run } from './exec';
import { logger } from './logger';

let ensurePromise: Promise<void> | null = null;

async function checkModules(): Promise<{ missing: string[]; resultCode: number; stdout: string; stderr: string; durationMs: number; }> {
  const checkArgs = [
    '-c',
    'import importlib.util,sys;mods=["librosa","pydub","torch","torchaudio","pyannote.audio","soundfile"];missing=[m for m in mods if importlib.util.find_spec(m) is None];print(",".join(missing));sys.exit(0 if not missing else 1)',
  ];

  const result = await run('python3', checkArgs);
  const missing = (result.stdout || '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  return {
    missing,
    resultCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  };
}

async function installModules(missing: string[]): Promise<void> {
  const requirementsPath = path.join(process.cwd(), 'scripts', 'audio_requirements.txt');
  logger.info('Installing Python audio dependencies', {
    requirementsPath,
    missingModules: missing,
  });
  const installArgs = ['-m', 'pip', 'install', '--no-cache-dir', '-r', requirementsPath];
  const installResult = await run('python3', installArgs, { timeout: 600000 });
  if (installResult.code !== 0) {
    logger.error('Failed to install Python audio dependencies', {
      code: installResult.code,
      stdoutPreview: (installResult.stdout || '').slice(0, 2000),
      stderrPreview: (installResult.stderr || '').slice(0, 2000),
    });
    throw new Error('Unable to install required Python packages');
  }
  logger.info('Python audio dependencies installed successfully', {
    durationMs: installResult.durationMs,
  });
}

export async function ensurePythonAudioDeps(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const check = await checkModules();
      if (check.resultCode === 0 || check.missing.length === 0) {
        logger.debug('Python audio dependencies already satisfied', {
          durationMs: check.durationMs,
        });
        return;
      }

      logger.warn('Missing Python audio dependencies detected', {
        missing: check.missing,
        stdoutPreview: (check.stdout || '').slice(0, 800),
        stderrPreview: (check.stderr || '').slice(0, 800),
      });

      await installModules(check.missing);

      const recheck = await checkModules();
      if (recheck.resultCode !== 0 || recheck.missing.length > 0) {
        logger.error('Python audio dependencies missing after install attempt', {
          missing: recheck.missing,
          stdoutPreview: (recheck.stdout || '').slice(0, 800),
          stderrPreview: (recheck.stderr || '').slice(0, 800),
        });
        throw new Error(`Python dependencies still missing: ${recheck.missing.join(', ')}`);
      }
    })().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}

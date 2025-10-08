import * as path from 'path';
import { run } from './exec';
import { logger } from './logger';

let ensurePromise: Promise<void> | null = null;

type CheckResult = {
  missing: string[];
  needsDowngrade: boolean;
  numpyVersion?: string;
};

async function checkModules(): Promise<{ check: CheckResult; resultCode: number; stdout: string; stderr: string; durationMs: number; }> {
  const checkScript = `
import importlib.util
import json
import sys

modules = ["librosa","pydub","torch","torchaudio","pyannote.audio","soundfile"]
missing = [m for m in modules if importlib.util.find_spec(m) is None]
needs_downgrade = False
numpy_version = None

try:
    import numpy
    numpy_version = numpy.__version__
    major = int(numpy_version.split(".")[0])
    if major >= 2:
        needs_downgrade = True
except Exception:
    missing.append("numpy")

result = {"missing": missing, "needsDowngrade": needs_downgrade, "numpyVersion": numpy_version}
print(json.dumps(result))
sys.exit(0 if not missing and not needs_downgrade else 1)
`;

  const result = await run('python3', ['-c', checkScript]);
  let parsed: CheckResult = { missing: [], needsDowngrade: false };
  try {
    parsed = JSON.parse(result.stdout || '{}') as CheckResult;
  } catch (error) {
    logger.warn(
      {
        stdout: result.stdout,
        stderr: result.stderr,
        parseError: error instanceof Error ? error.message : String(error),
      },
      'Failed to parse python dependency check output'
    );
  }
  return {
    check: parsed,
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
      if (check.resultCode === 0 && !check.check.needsDowngrade) {
        logger.debug('Python audio dependencies already satisfied', {
          durationMs: check.durationMs,
          numpyVersion: check.check.numpyVersion,
        });
        return;
      }

      logger.warn('Missing Python audio dependencies detected', {
        missing: check.check.missing,
        numpyVersion: check.check.numpyVersion,
        needsDowngrade: check.check.needsDowngrade,
        stdoutPreview: (check.stdout || '').slice(0, 800),
        stderrPreview: (check.stderr || '').slice(0, 800),
      });

      await installModules(check.check.missing);

      const recheck = await checkModules();
      if (recheck.resultCode !== 0 || recheck.check.missing.length > 0 || recheck.check.needsDowngrade) {
        logger.error('Python audio dependencies missing after install attempt', {
          missing: recheck.check.missing,
          numpyVersion: recheck.check.numpyVersion,
          needsDowngrade: recheck.check.needsDowngrade,
          stdoutPreview: (recheck.stdout || '').slice(0, 800),
          stderrPreview: (recheck.stderr || '').slice(0, 800),
        });
        throw new Error(`Python dependencies still missing: ${recheck.check.missing.join(', ')}`);
      }
      logger.info('Python audio dependencies verified', {
        numpyVersion: recheck.check.numpyVersion,
      });
    })().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}

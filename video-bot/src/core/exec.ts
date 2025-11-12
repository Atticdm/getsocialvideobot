import { logger } from './logger';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  durationMs: number;
}

let execaModulePromise: Promise<typeof import('execa')> | null = null;

async function getExeca() {
  if (!execaModulePromise) {
    execaModulePromise = import('execa');
  }
  return execaModulePromise;
}

export async function run(
  command: string,
  args: string[] = [],
  options: { cwd?: string; timeout?: number } = {}
): Promise<ExecResult> {
  const startTime = Date.now();

  const { execa } = await getExeca();

  logger.debug('Executing command', {
    command, 
    args, 
    cwd: options.cwd,
    timeout: options.timeout 
  });

  try {
    const execaOptions: any = {};
    if (options.cwd) execaOptions.cwd = options.cwd;
    if (options.timeout) execaOptions.timeout = options.timeout;
    
    const result = await execa(command, args, execaOptions);

    const durationMs = Date.now() - startTime;
    
    logger.debug('Command executed successfully', {
      command,
      args,
      durationMs,
      code: result.exitCode,
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.exitCode,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    
    if (error && typeof error === 'object' && 'exitCode' in error) {
      const execaError = error as any;
      const stdout = execaError.stdout || '';
      const stderr = execaError.stderr || '';
      
      // Логируем полные stdout и stderr для диагностики
      logger.error('Command execution failed', {
        command,
        args: args.slice(0, 10), // Первые 10 аргументов для краткости
        commandLine: `${command} ${Array.isArray(args) ? args.slice(0, 5).join(' ') : ''}...`,
        durationMs,
        code: execaError.exitCode,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        stdoutPreview: stdout.slice(0, 1000), // Первые 1000 символов
        stderrPreview: stderr.slice(0, 1000), // Первые 1000 символов
      });
      
      // Логируем полные stderr и stdout отдельно для длинных выводов
      if (stderr.length > 1000) {
        logger.error('Full stderr output', { 
          command, 
          stderr,
          stderrLength: stderr.length 
        });
      }
      if (stdout.length > 1000) {
        logger.error('Full stdout output', { 
          command, 
          stdout,
          stdoutLength: stdout.length 
        });
      }

      return {
        stdout: stdout,
        stderr: stderr,
        code: execaError.exitCode || 1,
        durationMs,
      };
    }

    logger.error('Unexpected error during command execution', {
      command,
      args,
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    });

    throw error;
  }
}

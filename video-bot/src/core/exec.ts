import { execa } from 'execa';
import { logger } from './logger';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  durationMs: number;
}

export async function run(
  command: string,
  args: string[] = [],
  options: { cwd?: string; timeout?: number } = {}
): Promise<ExecResult> {
  const startTime = Date.now();
  
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
      logger.error('Command execution failed', {
        command,
        args,
        commandLine: `${command} ${Array.isArray(args) ? args.join(' ') : ''}`,
        durationMs,
        code: execaError.exitCode,
        stdout: execaError.stdout,
        stderr: execaError.stderr,
      });

      return {
        stdout: execaError.stdout || '',
        stderr: execaError.stderr || '',
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

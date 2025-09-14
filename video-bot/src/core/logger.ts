import pino from 'pino';
import { config } from './config';
import * as fs from 'fs-extra';
import * as path from 'path';

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
fs.ensureDirSync(logsDir);

const isDevelopment = config.NODE_ENV === 'development';

const loggerConfig: pino.LoggerOptions = {
  level: config.LOG_LEVEL,
  formatters: {
    level: (label) => ({ level: label }),
  },
};

if (isDevelopment) {
  // Pretty logging for development
  loggerConfig.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  };
} else {
  // File logging for production
  loggerConfig.transport = {
    targets: [
      {
        target: 'pino/file',
        options: { destination: path.join(logsDir, 'app.log') },
        level: 'info',
      },
      {
        target: 'pino/file',
        options: { destination: path.join(logsDir, 'error.log') },
        level: 'error',
      },
    ],
  };
}

export const logger = pino(loggerConfig);

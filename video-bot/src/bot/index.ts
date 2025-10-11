import { startPolling } from './telegraf';
import { logger } from '../core/logger';

startPolling().catch((error) => {
  logger.error('Unhandled error in bot polling', { error });
  process.exit(1);
});

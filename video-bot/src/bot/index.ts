import { startPolling } from './telegraf';
import { logger } from '../core/logger';
import { shutdownAnalytics } from '../core/analytics';

startPolling().catch((error) => {
  logger.error('Unhandled error in bot polling', { error });
  void shutdownAnalytics();
  process.exit(1);
});

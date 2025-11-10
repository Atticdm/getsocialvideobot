import { Pool } from 'pg';
import { config } from '../config';
import { logger } from '../logger';
import type { CreditsCheckResult, CreditsBalance, FeatureType, CreditType, UsageStats } from './types';
import { isAdmin } from './admin';
import { getPool as getDbPool, closeDbPool } from '../dbCache';
import { isRedsysEnabled, getRedsysPaymentPackage } from './redsys';

// Prepared statements для производительности
const GET_OR_CREATE_USER_CREDITS_QUERY = `
  INSERT INTO user_credits (user_id, created_at)
  VALUES ($1, NOW())
  ON CONFLICT (user_id) DO UPDATE SET user_id = user_credits.user_id
  RETURNING free_credit_used, paid_credits, total_operations, first_used_at, last_used_at
`;

const GET_USER_CREDITS_QUERY = `
  SELECT free_credit_used, paid_credits, total_operations, first_used_at, last_used_at
  FROM user_credits
  WHERE user_id = $1
  FOR UPDATE
`;

const USE_FREE_CREDIT_QUERY = `
  UPDATE user_credits
  SET 
    free_credit_used = TRUE,
    total_operations = total_operations + 1,
    first_used_at = COALESCE(first_used_at, NOW()),
    last_used_at = NOW(),
    updated_at = NOW()
  WHERE user_id = $1 AND free_credit_used = FALSE
  RETURNING free_credit_used, paid_credits
`;

const USE_PAID_CREDIT_QUERY = `
  UPDATE user_credits
  SET 
    paid_credits = paid_credits - 1,
    total_operations = total_operations + 1,
    first_used_at = COALESCE(first_used_at, NOW()),
    last_used_at = NOW(),
    updated_at = NOW()
  WHERE user_id = $1 AND paid_credits > 0
  RETURNING free_credit_used, paid_credits
`;

const ADD_CREDITS_QUERY = `
  INSERT INTO user_credits (user_id, paid_credits, created_at)
  VALUES ($1, $2, NOW())
  ON CONFLICT (user_id) 
  DO UPDATE SET 
    paid_credits = user_credits.paid_credits + $2,
    updated_at = NOW()
  RETURNING paid_credits
`;

const REFUND_CREDIT_QUERY = `
  UPDATE user_credits
  SET 
    paid_credits = paid_credits + 1,
    updated_at = NOW()
  WHERE user_id = $1
  RETURNING paid_credits
`;

const LOG_USAGE_QUERY = `
  INSERT INTO credit_usage_log (user_id, feature, credit_type, provider, operation_successful)
  VALUES ($1, $2, $3, $4, $5)
`;

const GET_BALANCE_QUERY = `
  SELECT free_credit_used, paid_credits, total_operations, first_used_at, last_used_at
  FROM user_credits
  WHERE user_id = $1
`;

const GET_USAGE_STATS_QUERY = `
  SELECT 
    COUNT(*) FILTER (WHERE feature = 'translate') as translations,
    COUNT(*) FILTER (WHERE feature = 'voice_over') as voice_overs,
    COUNT(*) as total_operations
  FROM credit_usage_log
  WHERE user_id = $1 AND operation_successful = TRUE
`;

async function ensureUserCreditsRecord(userId: number, pool: Pool): Promise<void> {
  try {
    await pool.query(GET_OR_CREATE_USER_CREDITS_QUERY, [userId]);
  } catch (error: unknown) {
    logger.warn({ error, userId }, 'Failed to ensure user credits record');
    // Не выбрасываем ошибку - продолжим с проверкой
  }
}

export async function checkCreditsAvailable(
  userId: number | undefined,
  feature: FeatureType
): Promise<CreditsCheckResult> {
  // Проверка администратора
  if (isAdmin(userId)) {
    return {
      available: true,
      creditType: 'admin',
      creditsRemaining: Infinity,
    };
  }

  if (!userId) {
    return {
      available: false,
      creditType: null,
      creditsRemaining: 0,
      message: 'Не удалось определить пользователя',
    };
  }

  // Если платежи отключены, разрешаем использование
  if (!config.PAYMENT_ENABLED) {
    return {
      available: true,
      creditType: 'free',
      creditsRemaining: Infinity,
    };
  }

  const pool = getDbPool();
  if (!pool) {
    // Если БД недоступна, но платежи включены - блокируем использование
    // Это предотвращает бесплатное использование при проблемах с БД
    logger.error({ userId, feature }, 'Database unavailable, blocking feature usage');
    return {
      available: false,
      creditType: null,
      creditsRemaining: 0,
      message: '❌ Сервис временно недоступен. Система платежей не может проверить ваш баланс. Попробуйте позже или обратитесь в поддержку (/support).',
    };
  }

  try {
    await ensureUserCreditsRecord(userId, pool);

    const result = await pool.query(GET_USER_CREDITS_QUERY, [userId]);
    
    if (result.rows.length === 0) {
      // Пользователь не найден - создадим запись и дадим бесплатный кредит
      return {
        available: true,
        creditType: 'free',
        creditsRemaining: 1,
      };
    }

    const row = result.rows[0];
    const freeCreditUsed = row.free_credit_used;
    const paidCredits = Number(row.paid_credits) || 0;

    // Проверяем бесплатный кредит
    if (!freeCreditUsed) {
      return {
        available: true,
        creditType: 'free',
        creditsRemaining: 1,
      };
    }

    // Проверяем платные кредиты
    if (paidCredits > 0) {
      return {
        available: true,
        creditType: 'paid',
        creditsRemaining: paidCredits,
      };
    }

    // Нет доступных кредитов - формируем сообщение с учетом доступных провайдеров
    const starsEnabled = true;
    const redsysEnabled = isRedsysEnabled();
    
    const packageCredits = config.STARS_PACKAGE_CREDITS || 10;
    const starsAmount = config.STARS_PACKAGE_PRICE || 500;
    const priceUsd = starsAmount / 100; // Stars to USD (1 Star = $0.01)
    
    let message = `❌ У вас нет доступных кредитов для ${feature === 'translate' ? 'перевода' : 'озвучки'}\n\n📊 Ваш баланс:\n• Бесплатный кредит: использован ✅\n• Платных кредитов: 0\n\n💰 Доступные способы оплаты:`;
    
    if (starsEnabled && redsysEnabled) {
      const redsysPackage = getRedsysPaymentPackage();
      const priceRub = (redsysPackage.rublesAmount || 0) / 100;
      message += `\n• ${packageCredits} кредитов за ${starsAmount} ⭐ Stars ($${priceUsd})\n• ${redsysPackage.credits} кредитов за ${priceRub} ${redsysPackage.currency || 'RUB'}`;
    } else if (starsEnabled) {
      message += `\n• ${packageCredits} кредитов за $${priceUsd} (${starsAmount} ⭐ Stars)`;
    } else if (redsysEnabled) {
      const redsysPackage = getRedsysPaymentPackage();
      const priceRub = (redsysPackage.rublesAmount || 0) / 100;
      message += `\n• ${redsysPackage.credits} кредитов за ${priceRub} ${redsysPackage.currency || 'RUB'}`;
    }

    return {
      available: false,
      creditType: null,
      creditsRemaining: 0,
      message,
    };
  } catch (error: unknown) {
    logger.error({ error, userId, feature }, 'Failed to check credits availability');
    // При ошибке БД блокируем использование, если платежи включены
    // Это предотвращает бесплатное использование при проблемах с БД
    return {
      available: false,
      creditType: null,
      creditsRemaining: 0,
      message: '❌ Ошибка проверки баланса. Попробуйте позже или обратитесь в поддержку (/support).',
    };
  }
}

export async function useCredit(
  userId: number | undefined,
  feature: FeatureType,
  creditType: CreditType,
  provider?: string
): Promise<boolean> {
  // Администраторы не тратят кредиты
  if (isAdmin(userId)) {
    await logUsage(userId!, feature, 'admin', provider, true);
    return true;
  }

  if (!userId) {
    return false;
  }

  // Если платежи отключены, не списываем кредиты
  if (!config.PAYMENT_ENABLED) {
    await logUsage(userId, feature, 'free', provider, true);
    return true;
  }

  const pool = getDbPool();
  if (!pool) {
    // Если БД недоступна, не списываем кредит
    // Это ошибка состояния - кредит должен был быть проверен до этого
    logger.error({ userId, feature }, 'Database unavailable during credit deduction - this should not happen');
    return false;
  }

  try {
    await ensureUserCreditsRecord(userId, pool);

    let result;
    if (creditType === 'free') {
      result = await pool.query(USE_FREE_CREDIT_QUERY, [userId]);
      if (result.rows.length === 0) {
        // Бесплатный кредит уже использован, попробуем платный
        logger.warn({ userId }, 'Free credit already used, trying paid credit');
        result = await pool.query(USE_PAID_CREDIT_QUERY, [userId]);
        if (result.rows.length === 0) {
          logger.error({ userId }, 'Failed to deduct credit - no credits available');
          await logUsage(userId, feature, 'free', provider, false);
          return false;
        }
        await logUsage(userId, feature, 'paid', provider, true);
        return true;
      }
      await logUsage(userId, feature, 'free', provider, true);
      return true;
    } else if (creditType === 'paid') {
      result = await pool.query(USE_PAID_CREDIT_QUERY, [userId]);
      if (result.rows.length === 0) {
        logger.error({ userId }, 'Failed to deduct paid credit - insufficient balance');
        await logUsage(userId, feature, 'paid', provider, false);
        return false;
      }
      await logUsage(userId, feature, 'paid', provider, true);
      return true;
    }

    return false;
  } catch (error: unknown) {
    logger.error({ error, userId, feature, creditType }, 'Failed to use credit');
    await logUsage(userId, feature, creditType, provider, false);
    return false;
  }
}

export async function addCredits(
  userId: number,
  credits: number,
  paymentChargeId: string
): Promise<boolean> {
  const pool = getDbPool();
  if (!pool) {
    logger.error({ userId, credits, paymentChargeId }, 'Database unavailable, cannot add credits');
    return false;
  }

  try {
    await ensureUserCreditsRecord(userId, pool);

    const result = await pool.query(ADD_CREDITS_QUERY, [userId, credits]);
    
    if (result.rows.length > 0) {
      logger.info(
        { userId, credits, paymentChargeId, newBalance: result.rows[0].paid_credits },
        'Credits added successfully'
      );
      return true;
    }

    return false;
  } catch (error: unknown) {
    logger.error({ error, userId, credits, paymentChargeId }, 'Failed to add credits');
    return false;
  }
}

export async function refundCredit(userId: number, feature: FeatureType): Promise<void> {
  const pool = getDbPool();
  if (!pool) {
    logger.warn({ userId, feature }, 'Database unavailable, cannot refund credit');
    return;
  }

  try {
    const result = await pool.query(REFUND_CREDIT_QUERY, [userId]);
    if (result.rows.length > 0) {
      logger.info({ userId, feature, newBalance: result.rows[0].paid_credits }, 'Credit refunded');
    }
  } catch (error: unknown) {
    logger.error({ error, userId, feature }, 'Failed to refund credit');
  }
}

async function logUsage(
  userId: number,
  feature: FeatureType,
  creditType: CreditType,
  provider: string | undefined,
  successful: boolean
): Promise<void> {
  const pool = getDbPool();
  if (!pool) {
    return; // Не критично если не удалось залогировать
  }

  try {
    await pool.query(LOG_USAGE_QUERY, [userId, feature, creditType, provider || null, successful]);
  } catch (error: unknown) {
    logger.warn({ error, userId, feature }, 'Failed to log credit usage');
  }
}

export async function getCreditsBalance(userId: number | undefined): Promise<CreditsBalance | null> {
  if (!userId) {
    return null;
  }

  const pool = getDbPool();
  if (!pool) {
    return null;
  }

  try {
    await ensureUserCreditsRecord(userId, pool);

    const result = await pool.query(GET_BALANCE_QUERY, [userId]);
    
    if (result.rows.length === 0) {
      return {
        freeCreditUsed: false,
        paidCredits: 0,
        totalAvailable: 1, // Бесплатный кредит еще доступен
        totalOperations: 0,
        firstUsedAt: null,
        lastUsedAt: null,
      };
    }

    const row = result.rows[0];
    const freeCreditUsed = row.free_credit_used;
    const paidCredits = Number(row.paid_credits) || 0;
    const totalAvailable = (freeCreditUsed ? 0 : 1) + paidCredits;

    return {
      freeCreditUsed,
      paidCredits,
      totalAvailable,
      totalOperations: Number(row.total_operations) || 0,
      firstUsedAt: row.first_used_at ? new Date(row.first_used_at) : null,
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    };
  } catch (error: unknown) {
    logger.error({ error, userId }, 'Failed to get credits balance');
    return null;
  }
}

export async function getUsageStats(userId: number | undefined): Promise<UsageStats | null> {
  if (!userId) {
    return null;
  }

  const pool = getDbPool();
  if (!pool) {
    return null;
  }

  try {
    const result = await pool.query(GET_USAGE_STATS_QUERY, [userId]);
    
    if (result.rows.length === 0) {
      return {
        totalOperations: 0,
        translations: 0,
        voiceOvers: 0,
      };
    }

    const row = result.rows[0];
    return {
      totalOperations: Number(row.total_operations) || 0,
      translations: Number(row.translations) || 0,
      voiceOvers: Number(row.voice_overs) || 0,
    };
  } catch (error: unknown) {
    logger.error({ error, userId }, 'Failed to get usage stats');
    return null;
  }
}

// Экспортируем функцию для закрытия пула (переиспользуем из dbCache)
export { closeDbPool };


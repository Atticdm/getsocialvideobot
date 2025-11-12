import { logger } from '../logger';
import { getPool as getDbPool } from '../dbCache';
import type { FeatureType } from './types';

// Prepared statements для производительности
const GET_PROMO_CODE_QUERY = `
  SELECT id, code, type, value, max_uses, used_count, expires_at, description
  FROM promo_codes
  WHERE code = $1
`;

const CHECK_PROMO_USAGE_QUERY = `
  SELECT id FROM promo_code_usage
  WHERE promo_code_id = $1 AND user_id = $2
`;

const CHECK_USER_UNLIMITED_STATUS_QUERY = `
  SELECT ups.promo_code_id, ups.expires_at, pc.code
  FROM user_promo_status ups
  JOIN promo_codes pc ON pc.id = ups.promo_code_id
  WHERE ups.user_id = $1 
    AND (ups.expires_at IS NULL OR ups.expires_at > NOW())
    AND pc.type = 'unlimited'
  LIMIT 1
`;

const USE_PROMO_CODE_QUERY = `
  INSERT INTO promo_code_usage (promo_code_id, user_id)
  VALUES ($1, $2)
  ON CONFLICT (promo_code_id, user_id) DO NOTHING
  RETURNING id
`;

const INCREMENT_PROMO_USAGE_COUNT_QUERY = `
  UPDATE promo_codes
  SET used_count = used_count + 1
  WHERE id = $1
  RETURNING used_count
`;

const ACTIVATE_UNLIMITED_PROMO_QUERY = `
  INSERT INTO user_promo_status (user_id, promo_code_id, expires_at)
  VALUES ($1, $2, $3)
  ON CONFLICT (user_id) 
  DO UPDATE SET 
    promo_code_id = EXCLUDED.promo_code_id,
    expires_at = EXCLUDED.expires_at,
    activated_at = NOW()
  RETURNING user_id
`;

// Запрос для получения кредитов из промокодов (для будущего использования)
// const GET_USER_PROMO_CREDITS_QUERY = `
//   SELECT 
//     COALESCE(SUM(CASE WHEN pc.type = 'credits' THEN pc.value ELSE 0 END), 0) as credits,
//     COALESCE(SUM(CASE WHEN pc.type = 'free_translations' THEN pc.value ELSE 0 END), 0) as translations,
//     COALESCE(SUM(CASE WHEN pc.type = 'free_voice_overs' THEN pc.value ELSE 0 END), 0) as voice_overs
//   FROM promo_code_usage pcu
//   JOIN promo_codes pc ON pc.id = pcu.promo_code_id
//   WHERE pcu.user_id = $1
//     AND pc.type IN ('credits', 'free_translations', 'free_voice_overs')
// `;

export interface PromoCode {
  id: number;
  code: string;
  type: 'unlimited' | 'credits' | 'free_translations' | 'free_voice_overs';
  value: number | null;
  maxUses: number | null;
  usedCount: number;
  expiresAt: Date | null;
  description: string | null;
}

export interface PromoActivationResult {
  success: boolean;
  message: string;
  promoType?: PromoCode['type'];
  value?: number;
}

/**
 * Проверяет, имеет ли пользователь активный безлимитный промокод
 */
export async function checkUnlimitedPromo(userId: number): Promise<boolean> {
  const pool = getDbPool();
  if (!pool) {
    return false;
  }

  try {
    const result = await pool.query(CHECK_USER_UNLIMITED_STATUS_QUERY, [userId]);
    return result.rows.length > 0;
  } catch (error: unknown) {
    logger.error({ error, userId }, 'Failed to check unlimited promo status');
    return false;
  }
}

/**
 * Активирует промокод для пользователя
 */
export async function activatePromoCode(
  userId: number,
  code: string
): Promise<PromoActivationResult> {
  const pool = getDbPool();
  if (!pool) {
    return {
      success: false,
      message: '❌ База данных недоступна. Попробуйте позже.',
    };
  }

  try {
    // Получаем промокод
    const promoResult = await pool.query(GET_PROMO_CODE_QUERY, [code.toUpperCase()]);
    
    if (promoResult.rows.length === 0) {
      return {
        success: false,
        message: '❌ Промокод не найден. Проверьте правильность написания.',
      };
    }

    const promo = promoResult.rows[0];
    const promoId = promo.id;
    const promoType = promo.type;
    const expiresAt = promo.expires_at ? new Date(promo.expires_at) : null;
    const maxUses = promo.max_uses;
    const usedCount = Number(promo.used_count) || 0;

    // Проверяем срок действия
    if (expiresAt && expiresAt < new Date()) {
      return {
        success: false,
        message: '❌ Промокод истек.',
      };
    }

    // Проверяем лимит использований
    if (maxUses !== null && usedCount >= maxUses) {
      return {
        success: false,
        message: '❌ Промокод больше недействителен (превышен лимит использований).',
      };
    }

    // Проверяем, не использовал ли пользователь уже этот промокод
    const usageCheck = await pool.query(CHECK_PROMO_USAGE_QUERY, [promoId, userId]);
    if (usageCheck.rows.length > 0) {
      return {
        success: false,
        message: '❌ Вы уже использовали этот промокод.',
      };
    }

    // Активируем промокод в зависимости от типа
    if (promoType === 'unlimited') {
      // Безлимитный доступ
      await pool.query(ACTIVATE_UNLIMITED_PROMO_QUERY, [userId, promoId, expiresAt]);
      await pool.query(USE_PROMO_CODE_QUERY, [promoId, userId]);
      await pool.query(INCREMENT_PROMO_USAGE_COUNT_QUERY, [promoId]);

      logger.info({ userId, code, promoType }, 'Unlimited promo code activated');
      
      return {
        success: true,
        message: '🎉 Промокод активирован! Вам предоставлен безлимитный доступ на все время!',
        promoType: 'unlimited',
      };
    } else {
      // Кредиты или бесплатные использования
      await pool.query(USE_PROMO_CODE_QUERY, [promoId, userId]);
      await pool.query(INCREMENT_PROMO_USAGE_COUNT_QUERY, [promoId]);

      const value = promo.value || 0;
      let message = '🎉 Промокод активирован!';
      
      if (promoType === 'credits') {
        // Начисляем кредиты пользователю
        const { addCredits } = await import('./credits');
        await addCredits(userId, value, `promo_${code}`);
        message += `\n💰 Вам начислено ${value} кредитов!`;
      } else if (promoType === 'free_translations') {
        message += `\n🌐 Вам доступно ${value} бесплатных переводов!`;
      } else if (promoType === 'free_voice_overs') {
        message += `\n🎙 Вам доступно ${value} бесплатных озвучек!`;
      }

      logger.info({ userId, code, promoType, value }, 'Promo code activated');

      return {
        success: true,
        message,
        promoType,
        value,
      };
    }
  } catch (error: unknown) {
    logger.error({ error, userId, code }, 'Failed to activate promo code');
    return {
      success: false,
      message: '❌ Ошибка активации промокода. Попробуйте позже или обратитесь в поддержку.',
    };
  }
}

/**
 * Проверяет доступность функции с учетом промокодов
 * Возвращает true если функция доступна через промокод
 */
export async function checkPromoFeatureAccess(
  userId: number,
  feature: FeatureType
): Promise<{ hasAccess: boolean; promoType?: string }> {
  const pool = getDbPool();
  if (!pool) {
    return { hasAccess: false };
  }

  try {
    // Проверяем безлимитный доступ
    const hasUnlimited = await checkUnlimitedPromo(userId);
    if (hasUnlimited) {
      return { hasAccess: true, promoType: 'unlimited' };
    }

    // Проверяем специфичные промокоды для функции
    const promoType = feature === 'translate' ? 'free_translations' : 'free_voice_overs';
    const result = await pool.query(`
      SELECT COUNT(*) as count
      FROM promo_code_usage pcu
      JOIN promo_codes pc ON pc.id = pcu.promo_code_id
      WHERE pcu.user_id = $1 AND pc.type = $2
    `, [userId, promoType]);

    const count = Number(result.rows[0]?.count) || 0;
    
    // TODO: В будущем можно добавить логику проверки использованных бесплатных переводов/озвучек
    // Пока что просто проверяем наличие промокода
    
    if (count > 0) {
      return { hasAccess: true, promoType };
    }
    return { hasAccess: false };
  } catch (error: unknown) {
    logger.error({ error, userId, feature }, 'Failed to check promo feature access');
    return { hasAccess: false };
  }
}


/**
 * Модуль для управления согласием пользователей с лицензионным соглашением
 */

import { Pool } from 'pg';
import { logger } from './logger';
import { getPool } from './dbCache';

const AGREEMENT_VERSION = '1.0';

// Prepared statements для работы с согласием
const CHECK_AGREEMENT_QUERY = `
  SELECT agreement_accepted, agreement_version, accepted_at
  FROM user_agreement
  WHERE user_id = $1
`;

const ACCEPT_AGREEMENT_QUERY = `
  INSERT INTO user_agreement (user_id, agreement_accepted, agreement_version, accepted_at, updated_at)
  VALUES ($1, TRUE, $2, NOW(), NOW())
  ON CONFLICT (user_id) 
  DO UPDATE SET 
    agreement_accepted = TRUE,
    agreement_version = $2,
    accepted_at = NOW(),
    updated_at = NOW()
`;

const CREATE_AGREEMENT_RECORD_QUERY = `
  INSERT INTO user_agreement (user_id, agreement_accepted, agreement_version)
  VALUES ($1, FALSE, $2)
  ON CONFLICT (user_id) DO NOTHING
`;

export interface AgreementStatus {
  accepted: boolean;
  version: string | null;
  acceptedAt: Date | null;
}

/**
 * Проверяет, принял ли пользователь лицензионное соглашение
 */
export async function checkUserAgreement(userId: number): Promise<AgreementStatus | null> {
  const pool = getPool();
  if (!pool) {
    logger.warn({ userId }, 'Database pool not available, cannot check agreement');
    return null;
  }

  try {
    const result = await pool.query(CHECK_AGREEMENT_QUERY, [userId]);
    
    if (result.rows.length === 0) {
      // Создаем запись для пользователя, если её нет
      await ensureAgreementRecord(userId, pool);
      return {
        accepted: false,
        version: null,
        acceptedAt: null,
      };
    }

    const row = result.rows[0];
    return {
      accepted: row.agreement_accepted || false,
      version: row.agreement_version || null,
      acceptedAt: row.accepted_at || null,
    };
  } catch (error: unknown) {
    logger.error({ error, userId }, 'Failed to check user agreement');
    return null;
  }
}

/**
 * Принимает лицензионное соглашение от пользователя
 */
export async function acceptAgreement(userId: number): Promise<boolean> {
  const pool = getPool();
  if (!pool) {
    logger.warn({ userId }, 'Database pool not available, cannot accept agreement');
    return false;
  }

  try {
    await pool.query(ACCEPT_AGREEMENT_QUERY, [userId, AGREEMENT_VERSION]);
    logger.info({ userId, version: AGREEMENT_VERSION }, 'User accepted agreement');
    return true;
  } catch (error: unknown) {
    logger.error({ error, userId }, 'Failed to accept agreement');
    return false;
  }
}

/**
 * Создает запись о соглашении для пользователя (если её нет)
 */
async function ensureAgreementRecord(userId: number, pool: Pool): Promise<void> {
  try {
    await pool.query(CREATE_AGREEMENT_RECORD_QUERY, [userId, AGREEMENT_VERSION]);
  } catch (error: unknown) {
    // Игнорируем ошибки, если запись уже существует
    if (error instanceof Error && error.message.includes('duplicate')) {
      return;
    }
    logger.warn({ error, userId }, 'Failed to create agreement record');
  }
}

/**
 * Получает текущую версию соглашения
 */
export function getAgreementVersion(): string {
  return AGREEMENT_VERSION;
}


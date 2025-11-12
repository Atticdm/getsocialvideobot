-- Migration: Create promo codes tables
-- This migration creates tables for managing promo codes and their usage

-- Table for promo codes
CREATE TABLE IF NOT EXISTS promo_codes (
  id SERIAL PRIMARY KEY,
  code VARCHAR(50) UNIQUE NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('unlimited', 'credits', 'free_translations', 'free_voice_overs')),
  value INTEGER, -- для credits, free_translations, free_voice_overs (NULL для unlimited)
  max_uses INTEGER, -- максимальное количество использований (NULL = безлимит)
  used_count INTEGER DEFAULT 0,
  expires_at TIMESTAMP, -- NULL = без срока действия
  created_at TIMESTAMP DEFAULT NOW(),
  created_by BIGINT, -- ID администратора, создавшего промокод
  description TEXT -- описание промокода
);

CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);
CREATE INDEX IF NOT EXISTS idx_promo_codes_expires_at ON promo_codes(expires_at) WHERE expires_at IS NOT NULL;

-- Table for tracking promo code usage by users
CREATE TABLE IF NOT EXISTS promo_code_usage (
  id SERIAL PRIMARY KEY,
  promo_code_id INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  used_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(promo_code_id, user_id) -- один пользователь может использовать промокод только один раз
);

CREATE INDEX IF NOT EXISTS idx_promo_usage_user ON promo_code_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_promo_usage_code ON promo_code_usage(promo_code_id);

-- Table for tracking unlimited promo code status per user
-- Это позволяет отслеживать, какие пользователи имеют безлимитный доступ
CREATE TABLE IF NOT EXISTS user_promo_status (
  user_id BIGINT PRIMARY KEY,
  promo_code_id INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  activated_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP, -- NULL = без срока действия (для GODMODE)
  
  FOREIGN KEY (user_id) REFERENCES user_credits(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_promo_status_code ON user_promo_status(promo_code_id);
CREATE INDEX IF NOT EXISTS idx_user_promo_status_expires ON user_promo_status(expires_at) WHERE expires_at IS NOT NULL;

-- Комментарии для документации
COMMENT ON TABLE promo_codes IS 'Promo codes for granting free credits or unlimited access';
COMMENT ON COLUMN promo_codes.type IS 'Type of promo: unlimited, credits, free_translations, free_voice_overs';
COMMENT ON COLUMN promo_codes.value IS 'Value for credits/translations/voice_overs (NULL for unlimited)';
COMMENT ON COLUMN promo_codes.max_uses IS 'Maximum number of times the promo can be used (NULL = unlimited)';
COMMENT ON TABLE promo_code_usage IS 'Tracks which users have used which promo codes';
COMMENT ON TABLE user_promo_status IS 'Tracks unlimited promo code status per user (e.g., GODMODE)';

-- Создаем промокод GODMODE (безлимитный доступ навсегда)
INSERT INTO promo_codes (code, type, value, max_uses, expires_at, description)
VALUES ('GODMODE', 'unlimited', NULL, NULL, NULL, 'Полный безлимитный доступ на все время')
ON CONFLICT (code) DO NOTHING;


-- Migration: Create payment and credits tables for Telegram Stars integration
-- This migration creates tables for managing user credits and payment transactions

-- Table for user credits balance
CREATE TABLE IF NOT EXISTS user_credits (
  user_id BIGINT PRIMARY KEY,
  free_credit_used BOOLEAN DEFAULT FALSE,  -- использован ли бесплатный кредит
  paid_credits INTEGER DEFAULT 0,            -- баланс платных кредитов
  total_operations INTEGER DEFAULT 0,        -- всего операций (для статистики)
  first_used_at TIMESTAMP,                   -- первое использование
  last_used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_credits_last_used ON user_credits(last_used_at);

-- Table for payment transactions
CREATE TABLE IF NOT EXISTS payment_transactions (
  id SERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  stars_amount INTEGER NOT NULL,            -- количество Stars
  credits_purchased INTEGER NOT NULL,        -- куплено кредитов (всегда 10)
  telegram_payment_charge_id VARCHAR(255) UNIQUE, -- ID от Telegram
  status VARCHAR(20) DEFAULT 'pending',      -- 'pending', 'completed', 'failed', 'refunded'
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  
  FOREIGN KEY (user_id) REFERENCES user_credits(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payment_user ON payment_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_status ON payment_transactions(status);
CREATE INDEX IF NOT EXISTS idx_payment_charge_id ON payment_transactions(telegram_payment_charge_id);

-- Table for credit usage log
CREATE TABLE IF NOT EXISTS credit_usage_log (
  id SERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  feature VARCHAR(50) NOT NULL,              -- 'translate', 'voice_over'
  credit_type VARCHAR(20) NOT NULL,          -- 'free', 'paid', 'admin'
  provider VARCHAR(50),                       -- 'hume', 'elevenlabs', etc.
  operation_successful BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (user_id) REFERENCES user_credits(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_usage_user_date ON credit_usage_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_feature ON credit_usage_log(feature);

-- Комментарии для документации
COMMENT ON TABLE user_credits IS 'User credits balance for paid features (translate and voice over)';
COMMENT ON COLUMN user_credits.free_credit_used IS 'Whether the user has used their one-time free credit';
COMMENT ON COLUMN user_credits.paid_credits IS 'Balance of purchased credits (1 credit = 1 operation)';
COMMENT ON TABLE payment_transactions IS 'Payment transactions history for Telegram Stars';
COMMENT ON COLUMN payment_transactions.telegram_payment_charge_id IS 'Unique payment ID from Telegram API';
COMMENT ON TABLE credit_usage_log IS 'Log of all credit usage operations for analytics';


-- Migration: Create user agreement table
-- This migration creates a table for tracking user agreement with terms of service

-- Table for tracking user agreement acceptance
CREATE TABLE IF NOT EXISTS user_agreement (
  user_id BIGINT PRIMARY KEY,
  agreement_accepted BOOLEAN DEFAULT FALSE,
  agreement_version VARCHAR(20) NOT NULL DEFAULT '1.0', -- версия соглашения
  accepted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (user_id) REFERENCES user_credits(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_agreement_accepted ON user_agreement(agreement_accepted);
CREATE INDEX IF NOT EXISTS idx_user_agreement_version ON user_agreement(agreement_version);

COMMENT ON TABLE user_agreement IS 'Tracks user acceptance of terms of service and license agreement';
COMMENT ON COLUMN user_agreement.agreement_version IS 'Version of the agreement that user accepted';
COMMENT ON COLUMN user_agreement.accepted_at IS 'Timestamp when user accepted the agreement';


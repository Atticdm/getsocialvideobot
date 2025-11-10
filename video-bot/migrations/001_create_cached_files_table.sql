-- Migration: Create cached_files table for PostgreSQL cache
-- This table stores Telegram file_id mappings for video URLs

CREATE TABLE IF NOT EXISTS cached_files (
  id SERIAL PRIMARY KEY,
  url_hash VARCHAR(64) UNIQUE NOT NULL,      -- SHA256 хеш URL для быстрого поиска
  original_url TEXT NOT NULL,                -- Оригинальная ссылка (для отладки и аналитики)
  file_id VARCHAR(255) NOT NULL,             -- Telegram file_id
  unique_id VARCHAR(255),                    -- Telegram file_unique_id
  type VARCHAR(20) NOT NULL CHECK (type IN ('document', 'video')),
  provider VARCHAR(50),                       -- 'instagram', 'facebook', 'youtube', etc.
  duration_seconds INTEGER,
  size_bytes BIGINT,
  stored_at TIMESTAMP DEFAULT NOW() NOT NULL,
  expires_at TIMESTAMP NOT NULL,             -- для автоматической очистки
  last_accessed_at TIMESTAMP DEFAULT NOW()   -- для аналитики использования
);

-- Индексы для производительности
CREATE UNIQUE INDEX IF NOT EXISTS idx_cached_files_url_hash ON cached_files(url_hash);
CREATE INDEX IF NOT EXISTS idx_cached_files_expires_at ON cached_files(expires_at);
CREATE INDEX IF NOT EXISTS idx_cached_files_provider ON cached_files(provider) WHERE provider IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cached_files_last_accessed ON cached_files(last_accessed_at);

-- Комментарии для документации
COMMENT ON TABLE cached_files IS 'Cache table for Telegram file_id mappings to video URLs';
COMMENT ON COLUMN cached_files.url_hash IS 'SHA256 hash of normalized URL for fast lookup';
COMMENT ON COLUMN cached_files.original_url IS 'Original video URL for debugging and analytics';
COMMENT ON COLUMN cached_files.file_id IS 'Telegram file_id for sending cached files';
COMMENT ON COLUMN cached_files.expires_at IS 'Expiration timestamp for automatic cleanup (30 days from stored_at)';
COMMENT ON COLUMN cached_files.last_accessed_at IS 'Last access timestamp for cache hit analytics';


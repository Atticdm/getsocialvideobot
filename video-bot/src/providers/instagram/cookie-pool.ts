import { logger } from '../../core/logger';
import { config } from '../../core/config';
import * as fs from 'fs-extra';
import * as path from 'path';

export interface CookieInfo {
  id: string;
  cookiesB64: string;
  lastUsed?: number;
  failureCount: number;
  isBlocked: boolean;
}

/**
 * Менеджер пула cookies для Instagram
 * Поддерживает ротацию множественных cookies для распределения нагрузки
 */
export class InstagramCookiePool {
  private cookies: CookieInfo[] = [];
  private currentIndex = 0;
  private readonly maxFailures = 3; // После 3 неудач cookie считается заблокированной
  private readonly failureResetTime = 3600000; // 1 час - время до сброса счетчика ошибок

  constructor() {
    this.loadCookies();
  }

  /**
   * Загружает cookies из переменной окружения
   * Поддерживает два формата:
   * 1. INSTAGRAM_COOKIES_B64 - одна cookie (старый формат, для обратной совместимости)
   * 2. INSTAGRAM_COOKIES_POOL_B64 - JSON массив cookies в формате:
   *    [{"id": "cookie1", "cookiesB64": "base64..."}, {"id": "cookie2", "cookiesB64": "base64..."}]
   */
  private loadCookies(): void {
    // Загружаем пул cookies (новый формат)
    const poolB64 = config['INSTAGRAM_COOKIES_POOL_B64']?.trim();
    if (poolB64) {
      try {
        const buf = Buffer.from(poolB64, 'base64');
        const poolJson = buf.toString('utf-8');
        const pool = JSON.parse(poolJson) as CookieInfo[];
        
        if (Array.isArray(pool) && pool.length > 0) {
          this.cookies = pool.map(cookie => ({
            ...cookie,
            failureCount: cookie.failureCount || 0,
            isBlocked: cookie.isBlocked || false,
          }));
          logger.info('Loaded Instagram cookie pool', { count: this.cookies.length });
          return;
        }
      } catch (error) {
        logger.warn('Failed to parse Instagram cookie pool, falling back to single cookie', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Fallback на одну cookie (старый формат для обратной совместимости)
    const singleCookieB64 = config['INSTAGRAM_COOKIES_B64']?.trim();
    if (singleCookieB64) {
      this.cookies = [{
        id: 'default',
        cookiesB64: singleCookieB64,
        failureCount: 0,
        isBlocked: false,
      }];
      logger.info('Loaded single Instagram cookie (legacy format)');
    }
  }

  /**
   * Получает следующую доступную cookie из пула
   * Использует round-robin ротацию с учетом заблокированных cookies
   */
  getNextCookie(): CookieInfo | null {
    if (this.cookies.length === 0) {
      return null;
    }

    // Фильтруем заблокированные cookies
    const availableCookies = this.cookies.filter(c => !c.isBlocked);
    
    if (availableCookies.length === 0) {
      logger.warn('All Instagram cookies are blocked, resetting failure counts');
      // Если все заблокированы, сбрасываем счетчики
      this.cookies.forEach(c => {
        c.failureCount = 0;
        c.isBlocked = false;
      });
      return this.cookies[0] || null;
    }

    // Round-robin ротация
    const cookie = availableCookies[this.currentIndex % availableCookies.length];
    if (!cookie) return null;
    
    this.currentIndex = (this.currentIndex + 1) % availableCookies.length;
    cookie.lastUsed = Date.now();
    return cookie;
  }

  /**
   * Получает конкретную cookie по ID
   */
  getCookieById(id: string): CookieInfo | null {
    return this.cookies.find(c => c.id === id) || null;
  }

  /**
   * Отмечает cookie как успешно использованную
   */
  markSuccess(cookieId: string): void {
    const cookie = this.cookies.find(c => c.id === cookieId);
    if (cookie) {
      cookie.failureCount = 0; // Сбрасываем счетчик ошибок при успехе
      cookie.isBlocked = false;
    }
  }

  /**
   * Отмечает неудачное использование cookie
   * После maxFailures неудач cookie помечается как заблокированная
   */
  markFailure(cookieId: string, errorCode?: string): void {
    const cookie = this.cookies.find(c => c.id === cookieId);
    if (!cookie) return;

    cookie.failureCount = (cookie.failureCount || 0) + 1;
    
    // Проверяем, нужно ли заблокировать cookie
    if (cookie.failureCount >= this.maxFailures) {
      cookie.isBlocked = true;
      logger.warn('Instagram cookie blocked due to failures', {
        cookieId,
        failureCount: cookie.failureCount,
        errorCode,
      });
    } else {
      logger.debug('Instagram cookie failure recorded', {
        cookieId,
        failureCount: cookie.failureCount,
        errorCode,
      });
    }
  }

  /**
   * Сбрасывает счетчик ошибок для cookie (через определенное время)
   */
  resetFailureCount(cookieId: string): void {
    const cookie = this.cookies.find(c => c.id === cookieId);
    if (cookie && cookie.lastUsed) {
      const timeSinceLastUse = Date.now() - cookie.lastUsed;
      if (timeSinceLastUse > this.failureResetTime) {
        cookie.failureCount = 0;
        cookie.isBlocked = false;
      }
    }
  }

  /**
   * Получает статистику пула cookies
   */
  getStats(): {
    total: number;
    available: number;
    blocked: number;
    cookies: Array<{ id: string; failureCount: number; isBlocked: boolean }>;
  } {
    return {
      total: this.cookies.length,
      available: this.cookies.filter(c => !c.isBlocked).length,
      blocked: this.cookies.filter(c => c.isBlocked).length,
      cookies: this.cookies.map(c => ({
        id: c.id,
        failureCount: c.failureCount,
        isBlocked: c.isBlocked,
      })),
    };
  }

  /**
   * Декодирует cookie из base64 и сохраняет во временный файл
   */
  async prepareCookieFile(cookie: CookieInfo, outDir: string): Promise<string | undefined> {
    if (!cookie.cookiesB64 || cookie.cookiesB64.length === 0) {
      return undefined;
    }

    try {
      let buf: Buffer;
      try {
        buf = Buffer.from(cookie.cookiesB64, 'base64');
        if (buf.length === 0 && cookie.cookiesB64.length > 0) {
          throw new Error('Base64 decoding resulted in empty buffer');
        }
      } catch (base64Error) {
        logger.warn('Failed to decode Instagram cookie from base64', {
          cookieId: cookie.id,
          error: base64Error instanceof Error ? base64Error.message : String(base64Error),
        });
        return undefined;
      }

      const cookiesPath = path.join(outDir, `ig_cookies_${cookie.id}.txt`);

      // Пробуем декодировать как UTF-8
      let cookiesText: string;
      try {
        cookiesText = buf.toString('utf-8');
        // Проверяем, что это валидный UTF-8 и похож на формат cookies
        if (!cookiesText.includes('\t') && !cookiesText.includes('domain') && !cookiesText.includes('cookie')) {
          throw new Error('Does not look like cookies format');
        }
      } catch (utf8Error) {
        // Пробуем другие кодировки
        try {
          if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
            cookiesText = buf.slice(2).toString('utf16le');
          } else if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
            const swapped = Buffer.alloc(buf.length - 2);
            for (let i = 2; i < buf.length; i += 2) {
              const byte1 = buf[i + 1];
              const byte2 = buf[i];
              if (byte1 !== undefined && byte2 !== undefined) {
                swapped[i - 2] = byte1;
                swapped[i - 1] = byte2;
              }
            }
            cookiesText = swapped.toString('utf16le');
          } else {
            cookiesText = buf.toString('latin1');
          }

          if (!cookiesText.includes('\t') && !cookiesText.includes('domain') && !cookiesText.includes('cookie')) {
            throw new Error('Decoded text does not look like cookies format');
          }
        } catch (decodeError) {
          logger.warn('Failed to decode Instagram cookie - invalid encoding or format', {
            cookieId: cookie.id,
            error: decodeError instanceof Error ? decodeError.message : String(decodeError),
          });
          return undefined;
        }
      }

      await fs.writeFile(cookiesPath, cookiesText, 'utf-8');
      logger.debug('Instagram cookie file prepared', {
        cookieId: cookie.id,
        cookiesLength: cookiesText.length,
      });
      return cookiesPath;
    } catch (error) {
      logger.warn('Failed to write Instagram cookie file', {
        cookieId: cookie.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}

// Singleton instance
let cookiePoolInstance: InstagramCookiePool | null = null;

export function getInstagramCookiePool(): InstagramCookiePool {
  if (!cookiePoolInstance) {
    cookiePoolInstance = new InstagramCookiePool();
  }
  return cookiePoolInstance;
}


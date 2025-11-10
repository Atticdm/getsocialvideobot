export type CreditType = 'free' | 'paid' | 'admin';
export type FeatureType = 'translate' | 'voice_over';
export type PaymentProvider = 'stars' | 'redsys';

export interface CreditsCheckResult {
  available: boolean;
  creditType: CreditType | null;
  creditsRemaining: number;
  message?: string; // Сообщение для пользователя если нет кредитов
}

export interface PaymentPackage {
  credits: number;
  starsAmount?: number; // Для Telegram Stars
  rublesAmount?: number; // Для Redsys и других провайдеров (в копейках)
  priceUsd: number;
  description: string;
  provider?: PaymentProvider; // Опционально для указания провайдера
  currency?: string; // Валюта для провайдера (XTR для Stars, RUB/EUR/USD для Redsys)
}

export interface CreditsBalance {
  freeCreditUsed: boolean;
  paidCredits: number;
  totalAvailable: number;
  totalOperations: number;
  firstUsedAt: Date | null;
  lastUsedAt: Date | null;
}

export interface UsageStats {
  totalOperations: number;
  translations: number;
  voiceOvers: number;
}


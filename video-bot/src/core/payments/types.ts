export type CreditType = 'free' | 'paid' | 'admin';
export type FeatureType = 'translate' | 'voice_over';

export interface CreditsCheckResult {
  available: boolean;
  creditType: CreditType | null;
  creditsRemaining: number;
  message?: string; // Сообщение для пользователя если нет кредитов
}

export interface PaymentPackage {
  credits: number;
  starsAmount: number;
  priceUsd: number;
  description: string;
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


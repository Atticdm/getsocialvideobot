export type TranslationDirection = 'auto' | 'en-ru' | 'ru-en';

export interface TranslationRequest {
  url: string;
  direction: TranslationDirection;
  sessionDir: string;
}

export interface TranslationStage {
  name: 'download' | 'extract-audio' | 'transcribe' | 'translate' | 'synthesize' | 'assemble-audio' | 'mux' | 'analyze-audio';
  startedAt: number;
  completedAt?: number;
  error?: string;
}

export interface TranslationResult {
  videoPath: string;
  transcriptPath: string;
  translatedText: string;
  audioPath: string;
  stages: TranslationStage[];
}

export type WhisperLanguage = 'en' | 'ru' | 'unknown';

export interface WhisperOutput {
  text: string;
  language: WhisperLanguage;
  detectedLanguageConfidence?: number;
}

export interface TranslationConfig {
  sourceLanguage: WhisperLanguage;
  targetLanguage: WhisperLanguage;
}

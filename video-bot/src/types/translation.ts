import type { VoicePreset } from './voice';

export type TranslationDirection = 'auto' | 'en-ru' | 'ru-en' | 'identity-ru' | 'identity-en';
export type TranslationEngine = 'hume' | 'elevenlabs';
export type TranslationMode = 'translate' | 'dubbing';

export interface TranslationRequest {
  url: string;
  direction: TranslationDirection;
  sessionDir: string;
}

export interface TranslationStage {
  name:
    | 'download'
    | 'separate'
    | 'analyze-audio'
    | 'transcribe'
    | 'translate'
    | 'synthesize'
    | 'elevenlabs-dub'
    | 'mux'
    | 'select-voice';
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
  mode: TranslationMode;
  engine: TranslationEngine;
  voicePreset?: VoicePreset['id'];
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

export interface TranslationOptions {
  direction: TranslationDirection;
  engine: TranslationEngine;
  mode: TranslationMode;
  voicePreset?: VoicePreset['id'];
}

export type VoiceEngine = 'elevenlabs';

export type VoiceLanguage = 'ru' | 'en';

export interface VoicePreset {
  id: 'terminator-ru' | 'terminator-en';
  label: string;
  language: VoiceLanguage;
  engine: VoiceEngine;
}

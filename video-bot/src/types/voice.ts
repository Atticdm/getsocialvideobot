export type VoiceEngine = 'elevenlabs';

export type VoiceLanguage = 'ru' | 'en';

export interface VoicePreset {
  id: 'terminator-ru' | 'terminator-en' | 'zhirinovsky-ru' | 'zhirinovsky-en';
  label: string;
  language: VoiceLanguage;
  engine: VoiceEngine;
}

export type VoiceMode = 'tts-voice';

import { Markup } from 'telegraf';

export const mainKeyboard = Markup.keyboard([
  ['🌐 Перевести видео', '🎙 Озвучить видео'],
  ['📣 Опубликовать в канал'],
]).resize();

export const translateDirectionKeyboard = Markup.keyboard([
  ['🇬🇧 → 🇷🇺', '🇷🇺 → 🇬🇧'],
  ['⬅️ Назад']
]).resize();

export const translateEngineKeyboard = Markup.keyboard([
  ['🚀 Быстрый (Hume)', '💎 Качественный (ElevenLabs)'],
  ['🎯 Голос Терминатора'],
  ['⬅️ Назад']
]).resize();

export const voiceLanguageKeyboard = Markup.keyboard([
  ['🇷🇺 Ролик на русском', '🇬🇧 Video in English'],
  ['⬅️ Назад']
]).resize();

export function voiceChoiceKeyboard(language: 'ru' | 'en') {
  const rows: string[][] = [];
  if (language === 'ru') {
    rows.push(['🤖 Terminator (RU)']);
  } else {
    rows.push(['🤖 Terminator (EN)']);
  }
  rows.push(['⬅️ Назад']);
  return Markup.keyboard(rows).resize();
}

export const removeKeyboard = Markup.removeKeyboard();

export const linkPromptKeyboard = Markup.keyboard([
  ['⬅️ Назад', 'Отмена']
]).resize();

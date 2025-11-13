import { Markup } from 'telegraf';

export const mainKeyboard = Markup.keyboard([
  ['⬇️ Скачать видео', '🌐 Перевести видео'],
  ['🎙 Озвучить видео'], // Arena publishing functionality is temporarily disabled
  // ['🎙 Озвучить видео', '📣 Опубликовать в канал'],
]).resize();

export const translateDirectionKeyboard = Markup.keyboard([
  ['🇬🇧 → 🇷🇺', '🇷🇺 → 🇬🇧'],
  ['⬅️ Назад']
]).resize();

export const translateEngineKeyboard = Markup.keyboard([
  ['🚀 Быстрый (Hume)', '💎 Качественный (ElevenLabs)'],
  ['🎯 Голос Терминатора', '🎤 Голос Жириновского'],
  ['⬅️ Назад']
]).resize();

export const voiceLanguageKeyboard = Markup.keyboard([
  ['🇷🇺 Ролик на русском', '🇬🇧 Video in English'],
  ['⬅️ Назад']
]).resize();

export function voiceChoiceKeyboard(language: 'ru' | 'en') {
  const rows: string[][] = [];
  if (language === 'ru') {
    rows.push(['🤖 Terminator (RU)', '🎤 Жириновский (RU)']);
  } else {
    rows.push(['🤖 Terminator (EN)', '🎤 Жириновский (EN)']);
  }
  rows.push(['⬅️ Назад']);
  return Markup.keyboard(rows).resize();
}

export const removeKeyboard = Markup.removeKeyboard();

export const linkPromptKeyboard = Markup.keyboard([
  ['⬅️ Назад', 'Отмена']
]).resize();

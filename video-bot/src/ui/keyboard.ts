import { Markup } from 'telegraf';

export const mainKeyboard = Markup.keyboard([['🌐 Translate', '🎙 Перевод с озвучкой']]).resize();

export const translationKeyboard = Markup.keyboard([
  ['🇬🇧 → 🇷🇺', '🇷🇺 → 🇬🇧'],
  ['🎬 Переозвучить'],
  ['⬅️ Back']
]).resize();

export const modeChoiceKeyboard = Markup.keyboard([
  ['🚀 Быстрый (Hume)', '💎 Качественный (ElevenLabs)'],
  ['🎯 Голос Терминатора'],
  ['⬅️ Back'],
]).resize();

export const dubbingLanguageKeyboard = Markup.keyboard([
  ['🇷🇺 Озвучить русским голосом', '🇬🇧 Озвучить английским голосом'],
  ['⬅️ Back']
]).resize();

export function voiceChoiceKeyboard(language: 'ru' | 'en') {
  const rows: string[][] = [];
  if (language === 'ru') {
    rows.push(['🤖 Terminator (RU)']);
  } else if (language === 'en') {
    rows.push(['🤖 Terminator (EN)']);
  } else {
    rows.push(['🤖 Terminator']);
  }
  rows.push(['⬅️ Back']);
  return Markup.keyboard(rows).resize();
}

export const removeKeyboard = Markup.removeKeyboard();

import { Markup } from 'telegraf';

export const mainKeyboard = Markup.keyboard([
  ['🌐 Translate']
]).resize();

export const translationKeyboard = Markup.keyboard([
  ['🇬🇧 → 🇷🇺', '🇷🇺 → 🇬🇧'],
  ['⬅️ Back']
]).resize();

export const engineChoiceKeyboard = Markup.keyboard([
  ['🚀 Быстрый (Hume)', '💎 Качественный (ElevenLabs)'],
  ['⬅️ Back']
]).resize();

export const removeKeyboard = Markup.removeKeyboard();

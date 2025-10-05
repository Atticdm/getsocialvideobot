import { Markup } from 'telegraf';

export const mainKeyboard = Markup.keyboard([
  ['📥 Download', '❓ Help'],
  ['🔧 Status', '🌐 Translate']
]).resize();

export const removeKeyboard = Markup.removeKeyboard();

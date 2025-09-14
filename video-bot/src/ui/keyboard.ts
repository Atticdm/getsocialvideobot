import { Markup } from 'telegraf';

export const mainKeyboard = Markup.keyboard([
  ['📥 Download', '❓ Help'],
  ['🔧 Status']
]).resize();

export const removeKeyboard = Markup.removeKeyboard();

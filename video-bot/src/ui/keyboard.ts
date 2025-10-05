import { Markup } from 'telegraf';

export const mainKeyboard = Markup.keyboard([
  ['📥 Download', '❓ Help'],
  ['🌐 EN→RU', '🌐 RU→EN'],
  ['🔧 Status', '❌ Cancel']
]).resize();

export const removeKeyboard = Markup.removeKeyboard();

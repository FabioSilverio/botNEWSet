import TelegramBot from 'node-telegram-bot-api';
import { NewsItem } from './types';

async function safeSend(bot: TelegramBot, chatId: string, text: string, opts: object, retries = 2): Promise<void> {
  for (let i = 0; i <= retries; i++) {
    try {
      await bot.sendMessage(chatId, text, opts);
      return;
    } catch (err) {
      if (i === retries) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s atrás`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min atrás`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h atrás`;
  const days = Math.floor(hours / 24);
  return `${days}d atrás`;
}

function scoreBar(score: number, max: number = 100): string {
  const filled = Math.round((Math.min(score, max) / max) * 5);
  return '█'.repeat(filled) + '░'.repeat(5 - filled);
}

function formatNewsItem(item: NewsItem, index: number): string {
  const bd = item.scoreBreakdown;
  const tags: string[] = [];
  if (bd.crossFeedScore > 0) tags.push('Multi-fonte');
  if (bd.trendingScore > 0) tags.push('Trending');
  if (bd.socialScore > 0) tags.push('Social');

  const tagText = tags.length > 0 ? tags.join(' | ') : '';

  return [
    `<b>${index + 1}. ${escapeHtml(item.title)}</b>`,
    `<a href="${item.link}">Ler mais</a>`,
    `${scoreBar(item.relevanceScore, 100)} <b>${item.relevanceScore}</b>pts ${tagText ? '(' + tagText + ')' : ''}`,
    `${escapeHtml(item.source)} - ${timeAgo(item.publishedAt)}`,
  ].join('\n');
}

export function createBot(token: string): TelegramBot {
  return new TelegramBot(token, { polling: true });
}

export async function sendNews(
  bot: TelegramBot,
  chatId: string,
  items: NewsItem[]
): Promise<void> {
  const htmlOpts = { parse_mode: 'HTML', disable_web_page_preview: true };

  if (items.length === 0) {
    await safeSend(bot, chatId, 'Nenhuma notícia nova encontrada no momento.', {});
    return;
  }

  const header = `<b>Trending - ${new Date().toLocaleDateString('pt-BR')}</b>\n\n`;
  const formatted = items.map((item, i) => formatNewsItem(item, i)).join('\n\n');
  const message = header + formatted;

  if (message.length <= 4096) {
    await safeSend(bot, chatId, message, htmlOpts);
  } else {
    const chunks: string[] = [];
    let current = header;

    for (let i = 0; i < items.length; i++) {
      const entry = formatNewsItem(items[i], i) + '\n\n';
      if (current.length + entry.length > 4000) {
        chunks.push(current);
        current = '';
      }
      current += entry;
    }
    if (current.trim()) chunks.push(current);

    for (const chunk of chunks) {
      await safeSend(bot, chatId, chunk, htmlOpts);
    }
  }
}

function formatLatestItem(item: NewsItem, index: number): string {
  return [
    `<b>${index + 1}. ${escapeHtml(item.title)}</b>`,
    `<a href="${item.link}">Ler mais</a>`,
    `${escapeHtml(item.source)} - ${timeAgo(item.publishedAt)}`,
  ].join('\n');
}

export async function sendLatestNews(
  bot: TelegramBot,
  chatId: string,
  items: NewsItem[]
): Promise<void> {
  const htmlOpts = { parse_mode: 'HTML', disable_web_page_preview: true };

  if (items.length === 0) {
    await safeSend(bot, chatId, 'Nenhuma notícia recente encontrada.', {});
    return;
  }

  const header = `<b>Mais recentes</b>\n\n`;
  const formatted = items.map((item, i) => formatLatestItem(item, i)).join('\n\n');
  const message = header + formatted;

  if (message.length <= 4096) {
    await safeSend(bot, chatId, message, htmlOpts);
  } else {
    const chunks: string[] = [];
    let current = header;

    for (let i = 0; i < items.length; i++) {
      const entry = formatLatestItem(items[i], i) + '\n\n';
      if (current.length + entry.length > 4000) {
        chunks.push(current);
        current = '';
      }
      current += entry;
    }
    if (current.trim()) chunks.push(current);

    for (const chunk of chunks) {
      await safeSend(bot, chatId, chunk, htmlOpts);
    }
  }
}

export async function sendSourcesList(
  bot: TelegramBot,
  chatId: string,
  sources: { name: string; category: string }[]
): Promise<void> {
  const byCategory = new Map<string, string[]>();
  for (const s of sources) {
    const list = byCategory.get(s.category) || [];
    list.push(s.name);
    byCategory.set(s.category, list);
  }

  let msg = '<b>Fontes ativas:</b>\n\n';
  for (const [category, names] of byCategory) {
    msg += `<b>${escapeHtml(category.toUpperCase())}</b>\n`;
    for (const name of names) {
      msg += `  - ${escapeHtml(name)}\n`;
    }
    msg += '\n';
  }

  await safeSend(bot, chatId, msg, { parse_mode: 'HTML' });
}

export async function sendHelp(
  bot: TelegramBot,
  chatId: string
): Promise<void> {
  const help = [
    '<b>Comandos disponíveis:</b>',
    '',
    '/latest ou /last - Notícias da última hora',
    '/trending - Top 10 mais relevantes do dia (com score)',
    '/money - Mercados e economia (com score)',
    '/meme - Top 5 memes mais populares do momento',
    '/sources - Listar fontes ativas',
    '/help - Mostrar esta mensagem',
  ].join('\n');

  await safeSend(bot, chatId, help, { parse_mode: 'HTML' });
}

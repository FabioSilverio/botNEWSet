import Parser from 'rss-parser';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import { NewsItem, ScoreBreakdown } from './types';
import { deduplicateBySimilarity, finalDedup } from './dedup';

const rssParser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'NewsAggregator/1.0' },
});

const DEFAULT_BREAKDOWN: ScoreBreakdown = {
  crossFeedScore: 0, recencyScore: 0, trendingScore: 0, socialScore: 0, totalScore: 0,
};

interface MoneyFeed {
  name: string;
  url: string;
  category: 'usa' | 'brasil' | 'economia';
}

const MONEY_FEEDS: MoneyFeed[] = [
  // EUA
  { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex', category: 'usa' },
  { name: 'CNBC', url: 'https://www.cnbc.com/id/10001147/device/rss/rss.html', category: 'usa' },
  { name: 'MarketWatch', url: 'https://feeds.marketwatch.com/marketwatch/topstories', category: 'usa' },
  { name: 'Seeking Alpha', url: 'https://seekingalpha.com/market_currents.xml', category: 'usa' },
  // Brasil / B3
  { name: 'InfoMoney', url: 'https://www.infomoney.com.br/feed/', category: 'brasil' },
  { name: 'InvestNews', url: 'https://investnews.com.br/feed/', category: 'brasil' },
  { name: 'Valor Econômico', url: 'https://valor.globo.com/rss/valor/', category: 'economia' },
];

// --- Fetch ---

async function fetchMoneyFeed(feed: MoneyFeed): Promise<NewsItem[]> {
  try {
    const parsed = await rssParser.parseURL(feed.url);
    return (parsed.items || []).map((item) => ({
      title: item.title || 'Sem título',
      link: item.link || '',
      source: feed.name,
      publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
      description: item.contentSnippet || item.content || '',
      relevanceScore: 0,
      scoreBreakdown: { ...DEFAULT_BREAKDOWN },
    }));
  } catch (err) {
    console.error(`[money] Erro ao buscar ${feed.name}: ${err}`);
    return [];
  }
}

async function fetchAllMoneyFeeds(): Promise<NewsItem[]> {
  const results = await Promise.allSettled(MONEY_FEEDS.map((f) => fetchMoneyFeed(f)));
  const all: NewsItem[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }

  // Dedup
  const seen = new Set<string>();
  return all.filter((item) => {
    const key = item.link.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- Scoring ---

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'to', 'of',
  'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'and', 'but', 'or',
  'not', 'so', 'yet', 'it', 'its', 'this', 'that', 'he', 'she', 'they', 'we',
  'you', 'my', 'your', 'his', 'her', 'their', 'our', 'what', 'which', 'who',
  'how', 'if', 'new', 'says', 'said', 'just', 'about', 'more', 'than', 'up',
  'de', 'da', 'do', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'um', 'uma',
  'por', 'para', 'com', 'sem', 'que', 'se', 'mais', 'mas', 'como', 'seu', 'sua',
  'foi', 'ser', 'ter', 'está', 'são', 'tem', 'vai', 'pode', 'diz', 'após',
  'ano', 'dia', 'vez', 'até', 'não', 'há', 'sobre', 'entre',
]);

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-záàâãéèêíïóôõöúçñ0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function scoreMoneyItems(items: NewsItem[]): NewsItem[] {
  // 1. Cross-feed
  for (let i = 0; i < items.length; i++) {
    const kwA = new Set(extractKeywords(items[i].title));
    const matchedSources = new Set([items[i].source]);
    let crossCount = 0;

    for (let j = 0; j < items.length; j++) {
      if (i === j || matchedSources.has(items[j].source)) continue;
      const kwB = extractKeywords(items[j].title);
      const overlap = kwB.filter((w) => kwA.has(w)).length;
      if (kwA.size > 0 && overlap / kwA.size >= 0.4) {
        crossCount++;
        matchedSources.add(items[j].source);
      }
    }
    items[i].scoreBreakdown.crossFeedScore = crossCount >= 3 ? 50 : crossCount >= 2 ? 40 : crossCount >= 1 ? 30 : 0;
  }

  // 2. Trending keywords
  const keywordFreq = new Map<string, number>();
  const itemKws: string[][] = [];
  for (const item of items) {
    const kws = [...new Set(extractKeywords(item.title + ' ' + item.description))];
    itemKws.push(kws);
    for (const kw of kws) keywordFreq.set(kw, (keywordFreq.get(kw) || 0) + 1);
  }
  const trending = new Set([...keywordFreq.entries()].filter(([, c]) => c >= 3).map(([k]) => k));
  for (let i = 0; i < items.length; i++) {
    const hits = itemKws[i].filter((kw) => trending.has(kw)).length;
    items[i].scoreBreakdown.trendingScore = Math.min(hits * 5, 30);
  }

  // 3. Recency
  const now = Date.now();
  for (const item of items) {
    const ageH = (now - item.publishedAt.getTime()) / (1000 * 60 * 60);
    item.scoreBreakdown.recencyScore = Math.round(Math.max(0, 20 * (1 - ageH / 24)));
  }

  // Total
  for (const item of items) {
    const bd = item.scoreBreakdown;
    bd.totalScore = bd.crossFeedScore + bd.trendingScore + bd.recencyScore + bd.socialScore;
    item.relevanceScore = bd.totalScore;
  }

  return items;
}

// --- Formatação e envio ---

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s atrás`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min atrás`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h atrás`;
  return `${Math.floor(h / 24)}d atrás`;
}

function scoreBar(score: number, max: number = 100): string {
  const filled = Math.round((Math.min(score, max) / max) * 5);
  return '█'.repeat(filled) + '░'.repeat(5 - filled);
}

function formatMoneyItem(item: NewsItem, index: number): string {
  const bd = item.scoreBreakdown;
  const tags: string[] = [];
  if (bd.crossFeedScore > 0) tags.push('Multi-fonte');
  if (bd.trendingScore > 0) tags.push('Trending');
  const tagText = tags.length > 0 ? '(' + tags.join(' | ') + ')' : '';

  return [
    `<b>${index + 1}. ${escapeHtml(item.title)}</b>`,
    `<a href="${item.link}">Ler mais</a>`,
    `${scoreBar(item.relevanceScore)} <b>${item.relevanceScore}</b>pts ${tagText}`,
    `${escapeHtml(item.source)} - ${timeAgo(item.publishedAt)}`,
  ].join('\n');
}

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

export async function sendMoneyNews(
  bot: TelegramBot,
  chatId: string,
  count: number = 10
): Promise<void> {
  const htmlOpts = { parse_mode: 'HTML', disable_web_page_preview: true };

  console.log('[money] Buscando notícias financeiras...');
  const raw = await fetchAllMoneyFeeds();
  console.log(`[money] ${raw.length} itens buscados`);

  // Filtra últimas 24h
  const now = Date.now();
  const recent = raw.filter((item) => {
    const ageH = (now - item.publishedAt.getTime()) / (1000 * 60 * 60);
    return ageH <= 24 && ageH >= 0 && item.link;
  });

  const scored = scoreMoneyItems(recent);

  // Deduplica títulos similares
  const unique = deduplicateBySimilarity(scored);
  unique.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Diversificar: max 3 por fonte
  const diversified: NewsItem[] = [];
  const sourceCount = new Map<string, number>();
  for (const item of unique) {
    if (diversified.length >= count + 5) break; // pega extras pro dedup final
    const c = sourceCount.get(item.source) || 0;
    if (c >= 3) continue;
    diversified.push(item);
    sourceCount.set(item.source, c + 1);
  }

  // Última camada: finalDedup ultra-agressivo
  const result = finalDedup(diversified).slice(0, count);

  if (result.length === 0) {
    await safeSend(bot, chatId, 'Nenhuma notícia financeira encontrada no momento.', {});
    return;
  }

  const header = `<b>💰 Mercados &amp; Economia</b>\n\n`;
  const formatted = result.map((item, i) => formatMoneyItem(item, i)).join('\n\n');
  const message = header + formatted;

  if (message.length <= 4096) {
    await safeSend(bot, chatId, message, htmlOpts);
  } else {
    const chunks: string[] = [];
    let current = header;
    for (let i = 0; i < result.length; i++) {
      const entry = formatMoneyItem(result[i], i) + '\n\n';
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

  console.log(`[money] ${result.length} notícias financeiras enviadas`);
}

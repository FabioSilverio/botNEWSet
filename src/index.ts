import { loadConfig } from './config';
import { fetchAll } from './fetcher';
import { computeRelevance } from './popularity';
import { rankNews } from './ranker';
import { sendNews, sendLatestNews, sendSourcesList, sendHelp } from './telegram';
import { NewsItem } from './types';
import { sendMemes } from './memes';
import { sendMoneyNews } from './money';
import { finalDedup } from './dedup';
import TelegramBot from 'node-telegram-bot-api';

// ============================================================
// CONFIG
// ============================================================

const config = loadConfig();

const LATEST_MAX_AGE_HOURS = 1;
const LATEST_MAX_ITEMS = 15;

function log(tag: string, msg: string): void {
  console.log(`[${tag}] ${new Date().toISOString()} - ${msg}`);
}

// ============================================================
// BOT
// ============================================================

let isShuttingDown = false;
let pollingErrorCount = 0;
const MAX_POLLING_ERRORS = 10;

const bot = new TelegramBot(config.telegramBotToken, {
  polling: {
    autoStart: true,
    params: {
      timeout: 30,
    },
  },
});

// --- Erro de polling com auto-restart ---
bot.on('polling_error', (err: any) => {
  pollingErrorCount++;
  const errMsg = err?.message || String(err);
  log('bot', `Polling error #${pollingErrorCount}: ${errMsg}`);

  if (errMsg.includes('409') || errMsg.includes('Conflict')) {
    log('bot', '409 Conflict — reiniciando polling em 5s...');
    restartPolling();
    return;
  }

  if (pollingErrorCount >= MAX_POLLING_ERRORS) {
    log('bot', `${MAX_POLLING_ERRORS} erros seguidos — reiniciando polling em 10s...`);
    restartPolling();
    return;
  }
});

bot.on('error', (err) => {
  log('bot', `Bot error: ${err.message}`);
});

async function restartPolling(): Promise<void> {
  if (isShuttingDown) return;
  try {
    await bot.stopPolling();
  } catch (e) {
    log('bot', `Erro ao parar polling: ${e}`);
  }

  const delay = pollingErrorCount >= MAX_POLLING_ERRORS ? 10000 : 5000;
  log('bot', `Reiniciando polling em ${delay / 1000}s...`);

  setTimeout(async () => {
    if (isShuttingDown) return;
    try {
      pollingErrorCount = 0;
      await bot.startPolling();
      log('bot', 'Polling reiniciado!');
    } catch (e) {
      log('bot', `Falha ao reiniciar: ${e}. Tentando em 30s...`);
      setTimeout(() => restartPolling(), 30000);
    }
  }, delay);
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('shutdown', `Recebido ${signal}, desligando...`);
  try { await bot.stopPolling(); } catch {}
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  log('FATAL', `Uncaught exception: ${err.message}`);
  log('FATAL', err.stack || '');
});

process.on('unhandledRejection', (reason) => {
  log('FATAL', `Unhandled rejection: ${reason}`);
});

// ============================================================
// TIMEOUT WRAPPER
// ============================================================

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout de ${ms / 1000}s em ${label}`));
    }, ms);
    promise
      .then((val) => { clearTimeout(timer); resolve(val); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

// ============================================================
// PIPELINES
// ============================================================

async function fetchLatest(): Promise<NewsItem[]> {
  const rawItems = await withTimeout(fetchAll(config.feeds), 60000, 'fetchAll/latest');
  const now = Date.now();

  const recent = rawItems
    .filter((item) => {
      const ageHours = (now - item.publishedAt.getTime()) / (1000 * 60 * 60);
      return ageHours <= LATEST_MAX_AGE_HOURS && ageHours >= 0 && item.link;
    })
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

  const clean = finalDedup(recent);
  return clean.slice(0, LATEST_MAX_ITEMS);
}

async function runTrendingPipeline(): Promise<NewsItem[]> {
  log('trending', 'Iniciando busca...');

  const rawItems = await withTimeout(fetchAll(config.feeds), 60000, 'fetchAll/trending');
  log('trending', `${rawItems.length} itens brutos`);

  const now = Date.now();
  const recent = rawItems
    .filter((item) => {
      const ageHours = (now - item.publishedAt.getTime()) / (1000 * 60 * 60);
      return ageHours <= config.newsMaxAgeHours && item.link;
    })
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

  log('trending', `${recent.length} itens após filtro de idade`);

  const enriched = await withTimeout(computeRelevance(recent), 90000, 'computeRelevance');
  const ranked = rankNews(enriched, config.maxNewsPerSend, config.newsMaxAgeHours);
  const clean = finalDedup(ranked);

  log('trending', `${ranked.length} rankeados → ${clean.length} após dedup final`);
  return clean;
}

// ============================================================
// BOT COMMANDS
// ============================================================

bot.onText(/\/(latest|last)/, async (msg) => {
  const chatId = msg.chat.id.toString();
  try {
    await bot.sendMessage(chatId, '🔍 Buscando notícias da última hora...');
    const latest = await fetchLatest();
    await sendLatestNews(bot, chatId, latest);
  } catch (err) {
    log('latest', `Erro: ${err}`);
    try { await bot.sendMessage(chatId, `Erro ao buscar notícias: ${err}`); } catch {}
  }
});

bot.onText(/\/trend/, async (msg) => {
  const chatId = msg.chat.id.toString();
  try {
    await bot.sendMessage(chatId, '🔍 Buscando trending... aguarde ~30s');
    const topItems = await runTrendingPipeline();
    log('trending', `Enviando ${topItems.length} notícias`);
    await sendNews(bot, chatId, topItems);
  } catch (err) {
    log('trending', `Erro: ${err}`);
    try { await bot.sendMessage(chatId, `Erro: ${err}`); } catch {}
  }
});

bot.onText(/\/meme/, async (msg) => {
  const chatId = msg.chat.id.toString();
  try {
    await bot.sendMessage(chatId, '🔍 Buscando os melhores memes...');
    await sendMemes(bot, chatId, 5);
  } catch (err) {
    log('meme', `Erro: ${err}`);
    try { await bot.sendMessage(chatId, `Erro ao buscar memes: ${err}`); } catch {}
  }
});

bot.onText(/\/money/, async (msg) => {
  const chatId = msg.chat.id.toString();
  try {
    await bot.sendMessage(chatId, '🔍 Buscando notícias de mercado...');
    await sendMoneyNews(bot, chatId, 10);
  } catch (err) {
    log('money', `Erro: ${err}`);
    try { await bot.sendMessage(chatId, `Erro ao buscar notícias financeiras: ${err}`); } catch {}
  }
});

bot.onText(/\/sources/, async (msg) => {
  const chatId = msg.chat.id.toString();
  try {
    await sendSourcesList(
      bot,
      chatId,
      config.feeds.map((f) => ({ name: f.name, category: f.category }))
    );
  } catch {}
});

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id.toString();
  try { await sendHelp(bot, chatId); } catch {}
});

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id.toString();
  try {
    await bot.sendMessage(
      chatId,
      `News Aggregator ativo! Seu chat ID é: <code>${chatId}</code>\n\nUse /help para ver os comandos.`,
      { parse_mode: 'HTML' }
    );
  } catch {}
});

log('init', 'News Aggregator iniciado!');
log('init', `Feeds: ${config.feeds.length} fontes configuradas`);
log('init', `PID: ${process.pid}`);
log('init', 'Aguardando comandos...');

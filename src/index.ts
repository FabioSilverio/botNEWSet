import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from './config';
import { fetchAll } from './fetcher';
import { computeRelevance } from './popularity';
import { rankNews } from './ranker';
import { createBot, sendNews, sendLatestNews, sendSourcesList, sendHelp } from './telegram';
import { NewsItem } from './types';
import { sendMemes } from './memes';
import { sendMoneyNews } from './money';
import { finalDedup } from './dedup';
import TelegramBot from 'node-telegram-bot-api';

// ============================================================
// PID LOCK — impede múltiplos processos rodando ao mesmo tempo
// ============================================================

const PID_FILE = path.join(__dirname, '..', '.bot.pid');

function killExistingProcess(): void {
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          // Verifica se o processo ainda existe
          process.kill(oldPid, 0);
          // Se chegou aqui, o processo existe — mata ele
          console.log(`[lock] Matando processo anterior PID ${oldPid}...`);
          process.kill(oldPid, 'SIGTERM');
          // Espera um pouco
          const start = Date.now();
          while (Date.now() - start < 2000) {
            try { process.kill(oldPid, 0); } catch { break; }
          }
        } catch {
          // Processo não existe mais, tudo certo
        }
      }
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    // ignore
  }
}

function writePidFile(): void {
  try {
    fs.writeFileSync(PID_FILE, process.pid.toString(), 'utf-8');
  } catch {
    // ignore
  }
}

function removePidFile(): void {
  try {
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
      if (pid === process.pid) {
        fs.unlinkSync(PID_FILE);
      }
    }
  } catch {
    // ignore
  }
}

// Mata processo anterior antes de iniciar
killExistingProcess();
writePidFile();

// ============================================================
// CONFIG & BOT
// ============================================================

const config = loadConfig();

const LATEST_MAX_AGE_HOURS = 1;
const LATEST_MAX_ITEMS = 15;

function log(tag: string, msg: string): void {
  console.log(`[${tag}] ${new Date().toISOString()} - ${msg}`);
}

// ============================================================
// BOT COM AUTO-RESTART
// ============================================================

let bot: TelegramBot;
let isShuttingDown = false;
let pollingErrorCount = 0;
const MAX_POLLING_ERRORS = 10;

function startBot(): TelegramBot {
  log('bot', 'Iniciando bot com polling...');

  const newBot = new TelegramBot(config.telegramBotToken, {
    polling: {
      autoStart: true,
      params: {
        timeout: 30,
      },
    },
  });

  pollingErrorCount = 0;

  // --- Erro de polling ---
  newBot.on('polling_error', (err: any) => {
    pollingErrorCount++;
    const errMsg = err?.message || String(err);
    log('bot', `Polling error #${pollingErrorCount}: ${errMsg}`);

    // Se é erro 409 (conflito), reinicia o polling
    if (errMsg.includes('409') || errMsg.includes('Conflict')) {
      log('bot', '409 Conflict detectado — reiniciando polling em 5s...');
      restartPolling(newBot);
      return;
    }

    // Se acumulou muitos erros seguidos, reinicia
    if (pollingErrorCount >= MAX_POLLING_ERRORS) {
      log('bot', `${MAX_POLLING_ERRORS} erros seguidos — reiniciando polling em 10s...`);
      restartPolling(newBot);
      return;
    }
  });

  newBot.on('error', (err) => {
    log('bot', `Bot error: ${err.message}`);
  });

  return newBot;
}

async function restartPolling(botInstance: TelegramBot): Promise<void> {
  if (isShuttingDown) return;

  try {
    log('bot', 'Parando polling...');
    await botInstance.stopPolling();
  } catch (e) {
    log('bot', `Erro ao parar polling: ${e}`);
  }

  // Espera antes de reiniciar
  const delay = pollingErrorCount >= MAX_POLLING_ERRORS ? 10000 : 5000;
  log('bot', `Aguardando ${delay / 1000}s antes de reiniciar...`);

  setTimeout(async () => {
    if (isShuttingDown) return;
    try {
      pollingErrorCount = 0;
      log('bot', 'Reiniciando polling...');
      await botInstance.startPolling();
      log('bot', 'Polling reiniciado com sucesso!');
    } catch (e) {
      log('bot', `Falha ao reiniciar polling: ${e}. Tentando novamente em 30s...`);
      setTimeout(() => restartPolling(botInstance), 30000);
    }
  }, delay);
}

// ============================================================
// WATCHDOG — verifica a cada 5min se o bot tá vivo
// ============================================================

let lastCommandTime = Date.now();

setInterval(() => {
  const silenceMin = Math.round((Date.now() - lastCommandTime) / 60000);
  log('watchdog', `Bot ativo. Último comando: ${silenceMin}min atrás. PID: ${process.pid}`);
}, 5 * 60 * 1000);

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('shutdown', `Recebido ${signal}, desligando...`);

  try {
    await bot.stopPolling();
  } catch {
    // ignore
  }

  removePidFile();
  log('shutdown', 'Bot finalizado.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  log('FATAL', `Uncaught exception: ${err.message}`);
  log('FATAL', err.stack || '');
  // Não mata o processo — deixa o bot continuar
});

process.on('unhandledRejection', (reason) => {
  log('FATAL', `Unhandled rejection: ${reason}`);
  // Não mata o processo — deixa o bot continuar
});

// ============================================================
// TIMEOUT WRAPPER — previne que um comando trave pra sempre
// ============================================================

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout de ${ms / 1000}s atingido em ${label}`));
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
  log('trending', `${rawItems.length} itens brutos após dedup por URL`);

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

bot = startBot();

function registerCommands(b: TelegramBot): void {
  b.onText(/\/(latest|last)/, async (msg) => {
    lastCommandTime = Date.now();
    const chatId = msg.chat.id.toString();
    try {
      await b.sendMessage(chatId, '🔍 Buscando notícias da última hora...');
      const latest = await fetchLatest();
      await sendLatestNews(b, chatId, latest);
    } catch (err) {
      log('latest', `Erro: ${err}`);
      try { await b.sendMessage(chatId, `Erro ao buscar notícias: ${err}`); } catch {}
    }
  });

  b.onText(/\/trend/, async (msg) => {
    lastCommandTime = Date.now();
    const chatId = msg.chat.id.toString();
    try {
      await b.sendMessage(chatId, '🔍 Buscando trending... aguarde ~30s');
      const topItems = await runTrendingPipeline();
      log('trending', `Enviando ${topItems.length} notícias`);
      await sendNews(b, chatId, topItems);
    } catch (err) {
      log('trending', `Erro: ${err}`);
      try { await b.sendMessage(chatId, `Erro: ${err}`); } catch {}
    }
  });

  b.onText(/\/meme/, async (msg) => {
    lastCommandTime = Date.now();
    const chatId = msg.chat.id.toString();
    try {
      await b.sendMessage(chatId, '🔍 Buscando os melhores memes...');
      await sendMemes(b, chatId, 5);
    } catch (err) {
      log('meme', `Erro: ${err}`);
      try { await b.sendMessage(chatId, `Erro ao buscar memes: ${err}`); } catch {}
    }
  });

  b.onText(/\/money/, async (msg) => {
    lastCommandTime = Date.now();
    const chatId = msg.chat.id.toString();
    try {
      await b.sendMessage(chatId, '🔍 Buscando notícias de mercado...');
      await sendMoneyNews(b, chatId, 10);
    } catch (err) {
      log('money', `Erro: ${err}`);
      try { await b.sendMessage(chatId, `Erro ao buscar notícias financeiras: ${err}`); } catch {}
    }
  });

  b.onText(/\/sources/, async (msg) => {
    lastCommandTime = Date.now();
    const chatId = msg.chat.id.toString();
    try {
      await sendSourcesList(
        b,
        chatId,
        config.feeds.map((f) => ({ name: f.name, category: f.category }))
      );
    } catch {}
  });

  b.onText(/\/help/, async (msg) => {
    lastCommandTime = Date.now();
    const chatId = msg.chat.id.toString();
    try { await sendHelp(b, chatId); } catch {}
  });

  b.onText(/\/start/, async (msg) => {
    lastCommandTime = Date.now();
    const chatId = msg.chat.id.toString();
    try {
      await b.sendMessage(
        chatId,
        `News Aggregator ativo! Seu chat ID é: <code>${chatId}</code>\n\nUse /help para ver os comandos.`,
        { parse_mode: 'HTML' }
      );
    } catch {}
  });
}

registerCommands(bot);

log('init', 'News Aggregator iniciado!');
log('init', `Feeds: ${config.feeds.length} fontes configuradas`);
log('init', `PID: ${process.pid}`);
log('init', 'Aguardando comandos...');

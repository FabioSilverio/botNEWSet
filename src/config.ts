import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig, FeedsConfig } from './types';

dotenv.config();

function loadFeeds(): FeedsConfig {
  // Tenta vários caminhos (local: __dirname/.., Docker: /app, cwd)
  const candidates = [
    path.join(__dirname, '..', 'feeds.json'),
    path.join(process.cwd(), 'feeds.json'),
    '/app/feeds.json',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log(`[config] feeds.json encontrado em: ${p}`);
      const raw = fs.readFileSync(p, 'utf-8');
      return JSON.parse(raw) as FeedsConfig;
    }
  }
  throw new Error('feeds.json not found! Tried: ' + candidates.join(', '));
}

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnvInt(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? fallback : parsed;
}

export function loadConfig(): AppConfig {
  const feedsConfig = loadFeeds();

  return {
    telegramBotToken: requiredEnv('TELEGRAM_BOT_TOKEN'),
    telegramChatId: requiredEnv('TELEGRAM_CHAT_ID'),
    checkIntervalMinutes: optionalEnvInt('CHECK_INTERVAL_MINUTES', 30),
    maxNewsPerSend: optionalEnvInt('MAX_NEWS_PER_SEND', 10),
    newsMaxAgeHours: optionalEnvInt('NEWS_MAX_AGE_HOURS', 24),
    feeds: feedsConfig.feeds,
  };
}

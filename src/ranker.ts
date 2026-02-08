import * as fs from 'fs';
import * as path from 'path';
import { NewsItem } from './types';
import { deduplicateBySimilarity } from './dedup';

// Usa /tmp no servidor (Railway), ou pasta do projeto local
const SENT_CACHE_FILE = process.env.RAILWAY_ENVIRONMENT
  ? '/tmp/.sent-cache.json'
  : path.join(__dirname, '..', '.sent-cache.json');

function loadSentCache(): Set<string> {
  try {
    if (fs.existsSync(SENT_CACHE_FILE)) {
      const raw = fs.readFileSync(SENT_CACHE_FILE, 'utf-8');
      const data = JSON.parse(raw) as { urls: string[]; timestamp: number };

      if (Date.now() - data.timestamp > 48 * 60 * 60 * 1000) {
        return new Set();
      }
      return new Set(data.urls);
    }
  } catch {
    // ignore
  }
  return new Set();
}

function saveSentCache(urls: Set<string>): void {
  try {
    const data = { urls: Array.from(urls), timestamp: Date.now() };
    fs.writeFileSync(SENT_CACHE_FILE, JSON.stringify(data), 'utf-8');
  } catch {
    // ignore
  }
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '').toLowerCase();
}

/**
 * Diversified ranking: picks top items while ensuring no single source
 * dominates the results. Max 3 items per source.
 */
function diversifiedPick(sorted: NewsItem[], maxItems: number, maxPerSource: number = 3): NewsItem[] {
  const result: NewsItem[] = [];
  const sourceCount = new Map<string, number>();

  for (const item of sorted) {
    if (result.length >= maxItems) break;

    const count = sourceCount.get(item.source) || 0;
    if (count >= maxPerSource) continue;

    result.push(item);
    sourceCount.set(item.source, count + 1);
  }

  return result;
}

export function rankNews(
  items: NewsItem[],
  maxItems: number,
  maxAgeHours: number
): NewsItem[] {
  const now = Date.now();
  const sentCache = loadSentCache();

  const filtered = items.filter((item) => {
    const normalized = normalizeUrl(item.link);
    if (sentCache.has(normalized)) return false;

    const ageHours = (now - item.publishedAt.getTime()) / (1000 * 60 * 60);
    if (ageHours > maxAgeHours) return false;

    if (!item.link) return false;

    return true;
  });

  // Deduplica títulos similares antes de rankear
  const unique = deduplicateBySimilarity(filtered);

  // Sort by relevance score descending
  const sorted = unique.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Diversified pick — no more than 3 items from same source
  const topItems = diversifiedPick(sorted, maxItems);

  // Mark as sent
  for (const item of topItems) {
    sentCache.add(normalizeUrl(item.link));
  }
  saveSentCache(sentCache);

  return topItems;
}

export function getTopOfDay(
  items: NewsItem[],
  count: number = 5
): NewsItem[] {
  const now = Date.now();
  const last24h = items.filter((item) => {
    const ageHours = (now - item.publishedAt.getTime()) / (1000 * 60 * 60);
    return ageHours <= 24 && item.link;
  });

  const unique = deduplicateBySimilarity(last24h);
  const sorted = unique.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return diversifiedPick(sorted, count);
}

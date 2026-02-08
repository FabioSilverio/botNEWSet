import Parser from 'rss-parser';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { FeedSource, NewsItem } from './types';

const rssParser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'NewsAggregator/1.0',
  },
});

export async function fetchRSS(source: FeedSource): Promise<NewsItem[]> {
  try {
    const feed = await rssParser.parseURL(source.url);
    return (feed.items || []).map((item) => ({
      title: item.title || 'Sem título',
      link: item.link || '',
      source: source.name,
      publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
      description: item.contentSnippet || item.content || '',
      relevanceScore: 0,
      scoreBreakdown: DEFAULT_BREAKDOWN,
    }));
  } catch (err) {
    console.error(`[fetcher] Erro ao buscar RSS de ${source.name}: ${err}`);
    return [];
  }
}

export async function fetchHTTP(source: FeedSource): Promise<NewsItem[]> {
  try {
    const { data } = await axios.get(source.url, {
      timeout: 15000,
      headers: { 'User-Agent': 'NewsAggregator/1.0' },
    });
    const $ = cheerio.load(data);
    const items: NewsItem[] = [];

    $('a[href]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      const text = $el.text().trim();

      if (!href || !text || text.length < 20) return;

      const fullUrl = href.startsWith('http')
        ? href
        : new URL(href, source.url).toString();

      items.push({
        title: text.slice(0, 200),
        link: fullUrl,
        source: source.name,
        publishedAt: new Date(),
        description: '',
        relevanceScore: 0,
        scoreBreakdown: DEFAULT_BREAKDOWN,
      });
    });

    return items;
  } catch (err) {
    console.error(`[fetcher] Erro ao buscar HTTP de ${source.name}: ${err}`);
    return [];
  }
}

const DEFAULT_BREAKDOWN = { crossFeedScore: 0, recencyScore: 0, trendingScore: 0, socialScore: 0, totalScore: 0 };

export async function fetchReddit(source: FeedSource): Promise<NewsItem[]> {
  try {
    // source.url = subreddit name like "technology" or "worldnews"
    const subreddit = source.url;
    const jsonUrl = `https://www.reddit.com/r/${subreddit}/hot.json?limit=25`;
    const { data } = await axios.get(jsonUrl, {
      timeout: 15000,
      headers: { 'User-Agent': 'NewsAggregator/1.0 (by /u/newsbot)' },
    });

    if (!data?.data?.children) return [];

    return data.data.children
      .filter((child: any) => child.data && !child.data.stickied)
      .map((child: any) => {
        const post = child.data;
        const hasExternalUrl = post.url && !post.url.includes('reddit.com');
        return {
          title: post.title || 'Sem título',
          link: hasExternalUrl ? post.url : `https://www.reddit.com${post.permalink}`,
          source: `Reddit r/${subreddit}`,
          publishedAt: new Date(post.created_utc * 1000),
          description: post.selftext?.slice(0, 300) || '',
          relevanceScore: 0,
          scoreBreakdown: DEFAULT_BREAKDOWN,
        };
      });
  } catch (err) {
    console.error(`[fetcher] Erro ao buscar Reddit r/${source.url}: ${err}`);
    return [];
  }
}

function deduplicateByUrl(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const normalized = item.link.replace(/\/+$/, '').toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export async function fetchAll(sources: FeedSource[]): Promise<NewsItem[]> {
  const promises = sources.map((source) => {
    if (source.type === 'rss') return fetchRSS(source);
    if (source.type === 'reddit') return fetchReddit(source);
    return fetchHTTP(source);
  });

  const results = await Promise.allSettled(promises);
  const allItems: NewsItem[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allItems.push(...result.value);
    }
  }

  console.log(`[fetcher] Total de itens buscados: ${allItems.length}`);
  return deduplicateByUrl(allItems);
}

import axios from 'axios';
import { NewsItem, ScoreBreakdown } from './types';

const RATE_LIMIT_DELAY_MS = 200;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Tokenização simples para análise de keywords ---

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both',
  'either', 'neither', 'each', 'every', 'all', 'any', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than',
  'too', 'very', 'just', 'because', 'about', 'up', 'it', 'its', 'this',
  'that', 'these', 'those', 'he', 'she', 'they', 'we', 'you', 'i', 'me',
  'my', 'your', 'his', 'her', 'their', 'our', 'what', 'which', 'who',
  'when', 'where', 'why', 'how', 'if', 'while', 'new', 'says', 'said',
  // PT-BR stop words
  'de', 'da', 'do', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas',
  'um', 'uma', 'uns', 'umas', 'por', 'para', 'com', 'sem', 'sob',
  'sobre', 'entre', 'que', 'se', 'mais', 'mas', 'como', 'seu', 'sua',
  'seus', 'suas', 'ele', 'ela', 'eles', 'elas', 'isso', 'isto',
  'aquilo', 'este', 'esta', 'esse', 'essa', 'já', 'ainda', 'também',
  'foi', 'ser', 'ter', 'está', 'são', 'tem', 'vai', 'pode', 'diz',
  'após', 'ano', 'dia', 'vez', 'até', 'não', 'há',
]);

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-záàâãéèêíïóôõöúçñ0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

// --- 1. Cross-feed: detecta se o mesmo assunto aparece em múltiplas fontes ---

function computeCrossFeedScores(items: NewsItem[]): Map<number, number> {
  const scores = new Map<number, number>();

  for (let i = 0; i < items.length; i++) {
    const kwA = new Set(extractKeywords(items[i].title));
    let crossCount = 0;
    const matchedSources = new Set<string>();
    matchedSources.add(items[i].source);

    for (let j = 0; j < items.length; j++) {
      if (i === j || items[j].source === items[i].source) continue;
      if (matchedSources.has(items[j].source)) continue;

      const kwB = extractKeywords(items[j].title);
      const overlap = kwB.filter((w) => kwA.has(w)).length;
      const similarity = kwA.size > 0 ? overlap / kwA.size : 0;

      if (similarity >= 0.4) {
        crossCount++;
        matchedSources.add(items[j].source);
      }
    }

    // 0-1 sources = 0, 2 sources = 30, 3+ = 50+
    scores.set(i, crossCount >= 3 ? 50 : crossCount >= 2 ? 40 : crossCount >= 1 ? 30 : 0);
  }

  return scores;
}

// --- 2. Trending keywords: palavras que aparecem em muitas notícias diferentes ---

function computeTrendingScores(items: NewsItem[]): Map<number, number> {
  // Count keyword frequency across all items
  const keywordFreq = new Map<string, number>();
  const itemKeywords: string[][] = [];

  for (const item of items) {
    const kws = [...new Set(extractKeywords(item.title + ' ' + item.description))];
    itemKeywords.push(kws);
    for (const kw of kws) {
      keywordFreq.set(kw, (keywordFreq.get(kw) || 0) + 1);
    }
  }

  // Keywords that appear in 3+ different articles are "trending"
  const trendingKeywords = new Set<string>();
  for (const [kw, count] of keywordFreq) {
    if (count >= 3) trendingKeywords.add(kw);
  }

  const scores = new Map<number, number>();
  for (let i = 0; i < items.length; i++) {
    const kws = itemKeywords[i];
    const trendingHits = kws.filter((kw) => trendingKeywords.has(kw)).length;
    // Score: each trending keyword hit = 5pts, max 30
    scores.set(i, Math.min(trendingHits * 5, 30));
  }

  return scores;
}

// --- 3. Recency score: notícias mais recentes ganham mais pontos ---

function computeRecencyScores(items: NewsItem[]): Map<number, number> {
  const scores = new Map<number, number>();
  const now = Date.now();

  for (let i = 0; i < items.length; i++) {
    const ageHours = (now - items[i].publishedAt.getTime()) / (1000 * 60 * 60);
    // Max 20 pts for brand new, decays to 0 over 24h
    const score = Math.max(0, 20 * (1 - ageHours / 24));
    scores.set(i, Math.round(score));
  }

  return scores;
}

// --- 4. Social score (HN + Reddit) — consulta assíncrona ---

async function checkHackerNews(url: string): Promise<{ score: number; comments: number }> {
  try {
    const searchUrl = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(url)}&restrictSearchableAttributes=url&hitsPerPage=5`;
    const { data } = await axios.get(searchUrl, { timeout: 10000 });

    if (!data.hits || data.hits.length === 0) return { score: 0, comments: 0 };

    let bestScore = 0;
    let bestComments = 0;
    for (const hit of data.hits) {
      const score = hit.points || 0;
      const comments = hit.num_comments || 0;
      if (score > bestScore) {
        bestScore = score;
        bestComments = comments;
      }
    }
    return { score: bestScore, comments: bestComments };
  } catch {
    return { score: 0, comments: 0 };
  }
}

async function checkReddit(url: string): Promise<{ score: number; comments: number }> {
  try {
    const searchUrl = `https://www.reddit.com/search.json?q=url:${encodeURIComponent(url)}&sort=top&limit=5`;
    const { data } = await axios.get(searchUrl, {
      timeout: 10000,
      headers: { 'User-Agent': 'NewsAggregator/1.0' },
    });

    if (!data?.data?.children || data.data.children.length === 0) return { score: 0, comments: 0 };

    let bestScore = 0;
    let bestComments = 0;
    for (const child of data.data.children) {
      const post = child.data;
      const score = post.score || 0;
      const comments = post.num_comments || 0;
      if (score > bestScore) {
        bestScore = score;
        bestComments = comments;
      }
    }
    return { score: bestScore, comments: bestComments };
  } catch {
    return { score: 0, comments: 0 };
  }
}

async function getSocialScore(url: string): Promise<number> {
  const [hn, reddit] = await Promise.all([
    checkHackerNews(url),
    checkReddit(url),
  ]);
  // Normalize: cap social at 50 pts
  const raw = hn.score + hn.comments * 2 + reddit.score + reddit.comments * 2;
  return Math.min(raw, 50);
}

// --- Pipeline principal ---

export async function computeRelevance(items: NewsItem[]): Promise<NewsItem[]> {
  if (items.length === 0) return [];

  console.log(`[relevance] Calculando scores locais para ${items.length} itens...`);

  // Scores locais (rápidos, sem API)
  const crossFeed = computeCrossFeedScores(items);
  const trending = computeTrendingScores(items);
  const recency = computeRecencyScores(items);

  // Pre-score sem social para pré-rankear
  const preScored = items.map((item, i) => ({
    item,
    index: i,
    localScore: (crossFeed.get(i) || 0) + (trending.get(i) || 0) + (recency.get(i) || 0),
  }));

  // Só consulta social para os top 20 candidatos (economiza tempo)
  preScored.sort((a, b) => b.localScore - a.localScore);
  const topCandidates = preScored.slice(0, 20);

  console.log(`[relevance] Consultando APIs sociais para top ${topCandidates.length} candidatos...`);

  // Consulta social em batches de 5
  const socialScores = new Map<number, number>();
  for (let i = 0; i < topCandidates.length; i += 5) {
    const batch = topCandidates.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map(async (c) => ({
        index: c.index,
        score: await getSocialScore(c.item.link),
      }))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        socialScores.set(r.value.index, r.value.score);
      }
    }
    if (i + 5 < topCandidates.length) await delay(RATE_LIMIT_DELAY_MS * 2);
  }

  // Monta score final
  const enriched: NewsItem[] = items.map((item, i) => {
    const cf = crossFeed.get(i) || 0;
    const tr = trending.get(i) || 0;
    const rc = recency.get(i) || 0;
    const sc = socialScores.get(i) || 0;
    const total = cf + tr + rc + sc;

    return {
      ...item,
      relevanceScore: total,
      scoreBreakdown: {
        crossFeedScore: cf,
        trendingScore: tr,
        recencyScore: rc,
        socialScore: sc,
        totalScore: total,
      },
    };
  });

  console.log(`[relevance] Scores calculados. Top 5 scores: ${
    enriched
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 5)
      .map((e) => `${e.relevanceScore} (${e.source}: ${e.title.slice(0, 40)}...)`)
      .join(', ')
  }`);

  return enriched;
}

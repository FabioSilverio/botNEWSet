export interface FeedSource {
  name: string;
  url: string;
  type: 'rss' | 'http' | 'reddit';
  category: string;
}

export interface FeedsConfig {
  feeds: FeedSource[];
}

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  publishedAt: Date;
  description: string;
  relevanceScore: number;
  scoreBreakdown: ScoreBreakdown;
}

export interface ScoreBreakdown {
  crossFeedScore: number;    // Aparece em múltiplos feeds/fontes
  recencyScore: number;      // Quão recente é
  trendingScore: number;     // Keywords em alta (aparecem em muitas notícias)
  socialScore: number;       // HackerNews + Reddit (quando disponível)
  totalScore: number;
}

export interface AppConfig {
  telegramBotToken: string;
  telegramChatId: string;
  checkIntervalMinutes: number;
  maxNewsPerSend: number;
  newsMaxAgeHours: number;
  feeds: FeedSource[];
}

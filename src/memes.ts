import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';

interface RedditMeme {
  title: string;
  imageUrl: string;
  permalink: string;
  score: number;
  subreddit: string;
}

const MEME_SUBREDDITS = ['memes', 'dankmemes', 'me_irl', 'memesbr'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

function isImageUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.includes(ext)) || lower.includes('i.redd.it') || lower.includes('i.imgur.com');
}

async function fetchMemesFromSubreddit(subreddit: string): Promise<RedditMeme[]> {
  try {
    const { data } = await axios.get(
      `https://www.reddit.com/r/${subreddit}/hot.json?limit=15`,
      {
        timeout: 10000,
        headers: { 'User-Agent': 'NewsAggregator/1.0 (by /u/newsbot)' },
      }
    );

    if (!data?.data?.children) return [];

    return data.data.children
      .filter((child: any) => {
        const post = child.data;
        return (
          !post.stickied &&
          post.post_hint === 'image' &&
          isImageUrl(post.url) &&
          !post.over_18
        );
      })
      .map((child: any) => ({
        title: child.data.title,
        imageUrl: child.data.url,
        permalink: `https://www.reddit.com${child.data.permalink}`,
        score: child.data.score,
        subreddit,
      }));
  } catch (err) {
    console.error(`[memes] Erro ao buscar r/${subreddit}: ${err}`);
    return [];
  }
}

export async function fetchTopMemes(count: number = 5): Promise<RedditMeme[]> {
  const results = await Promise.allSettled(
    MEME_SUBREDDITS.map((sub) => fetchMemesFromSubreddit(sub))
  );

  const allMemes: RedditMeme[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      allMemes.push(...result.value);
    }
  }

  // Deduplica por URL de imagem
  const seen = new Set<string>();
  const unique = allMemes.filter((m) => {
    if (seen.has(m.imageUrl)) return false;
    seen.add(m.imageUrl);
    return true;
  });

  // Ordena por score e pega os top
  return unique.sort((a, b) => b.score - a.score).slice(0, count);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendMemes(
  bot: TelegramBot,
  chatId: string,
  count: number = 5
): Promise<void> {
  const memes = await fetchTopMemes(count);

  if (memes.length === 0) {
    await bot.sendMessage(chatId, 'Nenhum meme encontrado no momento.');
    return;
  }

  for (const meme of memes) {
    const caption = `<b>${escapeHtml(meme.title)}</b>\nr/${meme.subreddit} - ${meme.score} upvotes`;
    try {
      await bot.sendPhoto(chatId, meme.imageUrl, {
        caption,
        parse_mode: 'HTML',
      });
    } catch {
      // Fallback: envia como link se a imagem falhar
      await bot.sendMessage(
        chatId,
        `${caption}\n<a href="${meme.imageUrl}">Ver imagem</a>`,
        { parse_mode: 'HTML', disable_web_page_preview: false }
      );
    }
  }
}

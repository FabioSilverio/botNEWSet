import { NewsItem } from './types';

/**
 * Normaliza título para comparação:
 * - lowercase
 * - remove pontuação
 * - remove artigos e preposições curtas
 * - remove espaços extras
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[''"""\-–—]/g, ' ')
    .replace(/[^a-záàâãéèêíïóôõöúçñ0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stop words removidas da comparação — artigos, preposições, verbos auxiliares
 */
const DEDUP_STOP_WORDS = new Set([
  // EN
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of',
  'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'and', 'but', 'or',
  'it', 'its', 'this', 'that', 'has', 'have', 'had', 'will', 'not', 'no',
  'can', 'do', 'does', 'did', 'says', 'said', 'new', 'how', 'what', 'why',
  'who', 'when', 'where', 'after', 'over', 'up', 'out', 'into', 'about',
  // PT
  'de', 'da', 'do', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas',
  'um', 'uma', 'por', 'para', 'com', 'sem', 'que', 'se', 'mais', 'mas',
  'seu', 'sua', 'foi', 'ser', 'ter', 'diz', 'são', 'tem', 'vai',
  'sobre', 'entre', 'como', 'já', 'até', 'não', 'há', 'os', 'as',
]);

/**
 * Extrai palavras-chave significativas de um título normalizado.
 * Remove stop words e palavras muito curtas.
 */
function extractSignificantWords(title: string): string[] {
  return normalizeTitle(title)
    .split(' ')
    .filter((w) => w.length > 2 && !DEDUP_STOP_WORDS.has(w));
}

/**
 * Calcula Jaccard similarity entre dois conjuntos de palavras.
 */
function jaccardSimilarity(wordsA: string[], wordsB: string[]): number {
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }

  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Calcula overlap coefficient: intersection / min(|A|, |B|)
 * Melhor que Jaccard quando um título é substring do outro.
 * Ex: "Trump tariffs" vs "Trump announces new tariffs on China imports" → alto overlap
 */
function overlapCoefficient(wordsA: string[], wordsB: string[]): number {
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }

  return intersection / Math.min(setA.size, setB.size);
}

/**
 * Verifica se dois títulos falam sobre o mesmo assunto usando
 * múltiplas métricas combinadas.
 */
function areSimilar(titleA: string, titleB: string): boolean {
  const wordsA = extractSignificantWords(titleA);
  const wordsB = extractSignificantWords(titleB);

  // Se um dos dois é muito curto, ser mais exigente
  if (wordsA.length <= 2 || wordsB.length <= 2) {
    return jaccardSimilarity(wordsA, wordsB) >= 0.6;
  }

  const jaccard = jaccardSimilarity(wordsA, wordsB);
  const overlap = overlapCoefficient(wordsA, wordsB);

  // Qualquer uma das condições indica duplicata:
  // 1) Jaccard >= 0.35 (antes era 0.5 — agora mais agressivo)
  // 2) Overlap >= 0.65 (título curto contido no longo)
  // 3) Combinado: ambos acima de limites menores
  if (jaccard >= 0.35) return true;
  if (overlap >= 0.65) return true;
  if (jaccard >= 0.25 && overlap >= 0.5) return true;

  return false;
}

/**
 * Remove itens com títulos similares.
 * Mantém o item com maior relevanceScore entre os duplicados.
 * Muito mais agressivo que a versão anterior.
 */
export function deduplicateBySimilarity(
  items: NewsItem[],
  _threshold?: number // mantido para compatibilidade, mas ignorado
): NewsItem[] {
  if (items.length === 0) return [];

  // Ordena por score desc para manter sempre o melhor
  const sorted = [...items].sort((a, b) => b.relevanceScore - a.relevanceScore);
  const kept: NewsItem[] = [];
  const keptWords: string[][] = []; // cache de palavras já processadas

  for (const item of sorted) {
    const words = extractSignificantWords(item.title);

    // Verifica contra TODOS os itens já mantidos
    const isDuplicate = kept.some((_, idx) => {
      const existingWords = keptWords[idx];
      return areSimilar(item.title, kept[idx].title);
    });

    if (!isDuplicate) {
      kept.push(item);
      keptWords.push(words);
    }
  }

  return kept;
}

/**
 * Dedup rápido para uso final antes de enviar — última camada de proteção.
 * Ainda mais agressivo: threshold baixo.
 */
export function finalDedup(items: NewsItem[]): NewsItem[] {
  if (items.length === 0) return [];

  const result: NewsItem[] = [];
  const resultWords: string[][] = [];

  for (const item of items) {
    const words = extractSignificantWords(item.title);

    const isDuplicate = result.some((existing, idx) => {
      const jaccard = jaccardSimilarity(words, resultWords[idx]);
      const overlap = overlapCoefficient(words, resultWords[idx]);
      // Mais agressivo ainda na camada final
      return jaccard >= 0.3 || overlap >= 0.6 || (jaccard >= 0.2 && overlap >= 0.45);
    });

    if (!isDuplicate) {
      result.push(item);
      resultWords.push(words);
    }
  }

  return result;
}

/**
 * NewsAPI connector — the REAL unstructured feed.
 *
 * Pulls recent news articles about a company and normalizes them into documents
 * the retrieval engine can rank and spike-detect, exactly like the synthetic
 * reviews/tickets. Each article is theme-tagged with the shared tagger so a real
 * cluster of, say, "data breach" stories shows up as a software_bug spike.
 *
 * fetchArticles() never throws (returns [] on failure); normalizeArticles() is
 * pure and unit-tested offline. Requires NEWSAPI_KEY.
 *
 * Caveat: NewsAPI's free/developer tier only serves articles up to ~1 month old,
 * so the 12-month theme baseline is thin for news-only companies — the engine
 * will (correctly) stay cautious unless a clear cluster appears in-month.
 */
import { tagThemes, isNegative, periodFromDate } from "./themes";
import type { IngestDoc } from "./themes";

const NEWS_BASE = "https://newsapi.org/v2";
const MAX_ARTICLES = 100;

export function newsKey(): string | null {
  const k = process.env.NEWSAPI_KEY;
  if (!k || k === "your-newsapi-key-here" || k.trim().length < 8) return null;
  return k.trim();
}
export function newsConfigured(): boolean {
  return newsKey() !== null;
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/* ----------------------------------------------------------------- normalizer (pure) */

/**
 * NewsAPI-shaped articles → documents (region "Total"; category = source name).
 * Provider-agnostic: GNews returns the same {title,description,content,url,publishedAt,
 * source:{name}} shape, so its connector reuses this with source="gnews".
 */
export function normalizeArticles(articles: any[], company: string, source = "newsapi"): IngestDoc[] {
  if (!Array.isArray(articles)) return [];
  const out: IngestDoc[] = [];
  const seen = new Set<string>();
  for (const a of articles.slice(0, MAX_ARTICLES)) {
    const publishedAt = a?.publishedAt || "";
    const period = periodFromDate(publishedAt);
    const title = String(a?.title || "").trim();
    if (!period || !title) continue;

    const parts = [title, a?.description, a?.content].filter(Boolean).map(String);
    const text = parts.join(" ").replace(/\[\+\d+ chars\]$/i, "").slice(0, 2000).trim();
    const url = a?.url ? String(a.url) : undefined;
    const id = `${company}-news-${djb2(url || title)}`;
    if (seen.has(id)) continue;
    seen.add(id);

    out.push({
      company,
      document_id: id,
      type: "news",
      period,
      date: publishedAt,
      region: "Total",
      category: a?.source?.name ? String(a.source.name) : "news",
      text,
      themes: tagThemes(text),
      negative: isNegative(text),
      source,
      url,
    });
  }
  return out;
}

/* ------------------------------------------------------------------------ fetcher (I/O) */

async function fetchArticles(query: string, key: string): Promise<any[]> {
  try {
    const url =
      `${NEWS_BASE}/everything?q=${encodeURIComponent(query)}` +
      `&language=en&sortBy=publishedAt&pageSize=${MAX_ARTICLES}&apiKey=${key}`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const body = await r.json();
    return Array.isArray(body?.articles) ? body.articles : [];
  } catch {
    return [];
  }
}

export interface NewsPull {
  documents: IngestDoc[];
}

/** Pull recent news for a company and return normalized documents. */
export async function pullNews(ticker: string, companyName?: string | null): Promise<NewsPull> {
  const key = newsKey();
  if (!key) return { documents: [] };
  const query = companyName && companyName.length > 2 ? `"${companyName}"` : ticker;
  const articles = await fetchArticles(query, key);
  return { documents: normalizeArticles(articles, ticker) };
}

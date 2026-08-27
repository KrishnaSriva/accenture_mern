/**
 * GNews connector — an alternative REAL unstructured feed.
 *
 * Same job as the NewsAPI connector (news.ts): pull recent articles about a
 * company and normalize them into documents the retrieval engine can rank and
 * spike-detect. GNews.io is offered because its free tier accepts a personal
 * email (NewsAPI's does not), which unblocks self-serve setup.
 *
 * GNews returns the same article shape as NewsAPI
 * ({ title, description, content, url, publishedAt, source: { name } }),
 * so this connector reuses the shared normalizeArticles() with source="gnews".
 *
 * fetchGnewsArticles() never throws (returns [] on failure). Requires GNEWS_API_KEY.
 *
 * Caveat: GNews' free tier returns at most 10 articles per request and truncates
 * article content, so — like NewsAPI's thin history — the 12-month theme baseline
 * is light; the engine stays cautious unless a clear in-month cluster appears.
 */
import { normalizeArticles } from "./news";
import type { IngestDoc } from "./themes";

const GNEWS_BASE = "https://gnews.io/api/v4";
const MAX_ARTICLES = 10; // free-tier hard cap per request

export function gnewsKey(): string | null {
  const k = process.env.GNEWS_API_KEY;
  if (!k || k === "your-gnews-api-key-here" || k.trim().length < 8) return null;
  return k.trim();
}
export function gnewsConfigured(): boolean {
  return gnewsKey() !== null;
}

/* ------------------------------------------------------------------------ fetcher (I/O) */

async function fetchGnewsArticles(query: string, key: string): Promise<any[]> {
  try {
    const url =
      `${GNEWS_BASE}/search?q=${encodeURIComponent(query)}` +
      `&lang=en&sortby=publishedAt&max=${MAX_ARTICLES}&apikey=${key}`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const body = await r.json();
    return Array.isArray(body?.articles) ? body.articles : [];
  } catch {
    return [];
  }
}

export interface GnewsPull {
  documents: IngestDoc[];
}

/** Pull recent news for a company from GNews and return normalized documents. */
export async function pullGnews(ticker: string, companyName?: string | null): Promise<GnewsPull> {
  const key = gnewsKey();
  if (!key) return { documents: [] };
  const query = companyName && companyName.length > 2 ? `"${companyName}"` : ticker;
  const articles = await fetchGnewsArticles(query, key);
  return { documents: normalizeArticles(articles, ticker, "gnews") };
}

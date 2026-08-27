/**
 * Lightweight, dependency-free theme tagging + negativity heuristic.
 *
 * The synthetic DEMO data is tagged with themes by the Python generator; real
 * unstructured text pulled from FMP transcripts and NewsAPI has no tags, so we
 * derive them here with keyword matching. Themes MUST match the four the engine
 * looks for in retrieval.ts (software_bug, shipping_delay, product_quality,
 * competitor) so theme-spike detection works identically for real and demo data.
 *
 * This is deliberately simple (keyword lexicons, not ML): it is transparent,
 * deterministic, and runs offline. Pure functions → unit-testable without a DB.
 */

export const THEMES = ["software_bug", "shipping_delay", "product_quality", "competitor"] as const;
export type Theme = (typeof THEMES)[number];

const LEXICON: Record<Theme, string[]> = {
  software_bug: [
    "bug", "crash", "crashes", "crashing", "glitch", "error", "errors", "outage",
    "downtime", "down time", "sync", "sync failure", "freeze", "frozen", "patch",
    "defect", "malfunction", "not working", "won't load", "wont load", "login",
    "log in", "loading", "server error", "software issue", "broken feature", "cyberattack",
    "data breach", "hack", "security flaw",
  ],
  shipping_delay: [
    "shipping", "shipment", "delivery", "delivered late", "delayed", "delay", "late",
    "didn't arrive", "did not arrive", "logistics", "courier", "freight", "backorder",
    "back order", "out of stock", "customs", "warehouse", "fulfillment", "supply chain",
    "port", "stuck in transit",
  ],
  product_quality: [
    "quality", "defective", "broken", "poor quality", "damaged", "cheap", "faulty",
    "fell apart", "stopped working", "material", "flimsy", "wore out", "recall",
    "recalled", "counterfeit", "not as described", "poor build",
  ],
  competitor: [
    "competitor", "competition", "alternative", "switched to", "switching to", "rival",
    "better deal", "cheaper elsewhere", "moving to", "moved to", "instead of", "vs",
    "market share", "undercut", "price war", "lost customers to",
  ],
};

const NEGATIVE = [
  "bad", "terrible", "awful", "worst", "disappointed", "disappointing", "frustrated",
  "frustrating", "unhappy", "complaint", "complaints", "refund", "angry", "poor", "hate",
  "hated", "broken", "fail", "failed", "failure", "unacceptable", "cancel", "cancelled",
  "canceling", "not recommend", "avoid", "regret", "useless", "waste", "scam", "declined",
  "drop", "dropped", "fell", "plunge", "slump", "miss", "missed", "weak", "loss", "losses",
  "lawsuit", "fine", "fined", "investigation", "warning", "cut", "layoff", "layoffs",
];

function norm(text: string): string {
  return ` ${(text || "").toLowerCase().replace(/[^a-z0-9']+/g, " ")} `;
}

/** Return the themes whose lexicon matches the text (may be several, or none). */
export function tagThemes(text: string): Theme[] {
  const t = norm(text);
  const hits: Theme[] = [];
  for (const theme of THEMES) {
    if (LEXICON[theme].some((kw) => t.includes(` ${kw} `) || t.includes(`${kw} `) || t.includes(` ${kw}`))) {
      hits.push(theme);
    }
  }
  return hits;
}

/** Cheap negativity flag: any negative keyword present (or an explicit low rating). */
export function isNegative(text: string, rating?: number | null): boolean {
  if (typeof rating === "number") return rating <= 2;
  const t = norm(text);
  return NEGATIVE.some((kw) => t.includes(` ${kw} `));
}

/** Normalized document shape shared by every connector (matches the Document model). */
export interface IngestDoc {
  company: string;
  document_id: string;
  type: string;
  period: string; // YYYY-MM
  date: string; // ISO-ish
  region: string;
  category: string;
  text: string;
  themes: Theme[];
  negative: boolean;
  source: string; // fmp | newsapi | gnews
  url?: string;
}

/** Normalized KPI point shape shared by every connector (matches the KpiValue model). */
export interface IngestKpiValue {
  company: string;
  kpi_key: string;
  region: string;
  period: string; // YYYY-MM
  period_type: string; // month | quarter
  value: number;
}

/** "2024-09-28" | "2024-09-28T00:00:00Z" -> "2024-09" */
export function periodFromDate(date: string): string {
  const m = String(date || "").match(/(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : "";
}

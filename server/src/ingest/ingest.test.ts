/**
 * Ingest / connector tests — pure functions, no network, no DB.
 *
 *   npm test            (Node's built-in runner; type-stripped via ts-node)
 *
 * Proves the "Connect a company" path is correct OFFLINE: the pure normalizers turn
 * real-shaped FMP + NewsAPI payloads into the exact IngestKpiValue / IngestDoc shapes
 * the engine consumes, and that connector-derived evidence drives the REAL confidence
 * scorer to the same two-sided contract as the demo (confirmed vs. ambiguous).
 *
 * Fixtures below mirror the real API response shapes (abbreviated). No key required.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  THEMES,
  tagThemes,
  isNegative,
  periodFromDate,
  type IngestDoc,
  type IngestKpiValue,
} from "./themes";
import { normalizeIncome, normalizeGeo, normalizeTranscripts, canonicalRegion } from "./fmp";
import { normalizeArticles } from "./news";
import { gnewsConfigured } from "./gnews";
import { scoreConfidence } from "../engine/confidence";
import type { AnomalyResult } from "../engine/anomaly";
import type { DriverResult } from "../engine/drivers";
import type { RetrievalResult } from "../engine/retrieval";

/* --------------------------------------------------------------- real-shaped fixtures */

// FMP v3/income-statement?period=quarter
const INCOME = [
  { date: "2024-09-28", symbol: "AMZN", revenue: 158877000000, grossProfit: 78932000000, operatingExpenses: 47739000000 },
  { date: "2024-06-30", symbol: "AMZN", revenue: 147977000000, grossProfit: 73897000000, operatingExpenses: 45500000000 },
  { date: "2024-03-30", symbol: "AMZN", revenue: 143313000000, grossProfit: 70000000000, operatingExpenses: 44000000000 },
];

// FMP v4/revenue-geographic-segmentation?structure=flat  (flat: [{ "<date>": {region: value} }])
const GEO = [
  { "2024-09-28": { "United States Segment": 98413000000, "International Segment": 60464000000 } },
  { "2024-06-30": { "United States Segment": 90033000000, "International Segment": 57944000000 } },
];

// FMP v4/batch_earning_call_transcript
const TRANSCRIPTS = [
  {
    symbol: "AMZN",
    quarter: 3,
    year: 2024,
    date: "2024-10-31 17:00:00",
    content:
      "Thank you. This quarter our logistics network saw a shipping delay that pushed delivery times out; " +
      "freight and warehouse constraints weighed on the international segment.",
  },
];

// NewsAPI v2/everything -> body.articles[]
const NEWS_BUG_CLUSTER = [
  {
    source: { id: null, name: "Reuters" },
    title: "Amazon hit by major outage as software bug crashes services",
    description: "A software bug caused a widespread outage across several regions.",
    url: "https://example.com/a1",
    publishedAt: "2024-10-15T09:00:00Z",
    content: "The outage lasted hours and left customers unable to check out. [+1200 chars]",
  },
  {
    source: { name: "TechCrunch" },
    title: "Amazon app login errors frustrate users after botched patch",
    description: "Users report repeated login errors and crashes.",
    url: "https://example.com/a2",
    publishedAt: "2024-10-16T11:00:00Z",
    content: "A patch appears to have introduced a defect. [+800 chars]",
  },
  {
    source: { name: "The Verge" },
    title: "Sync failure hits Amazon sellers as backend error persists",
    description: "A sync failure and server error disrupted seller tools.",
    url: "https://example.com/a3",
    publishedAt: "2024-10-17T08:30:00Z",
    content: "Sellers could not update inventory during the downtime.",
  },
  {
    source: { name: "Bloomberg" },
    title: "Amazon data breach probe opens after security flaw report",
    description: "Regulators open an investigation into a reported security flaw.",
    url: "https://example.com/a4",
    publishedAt: "2024-10-18T14:00:00Z",
    content: "The company said it patched the flaw. [+400 chars]",
  },
  // duplicate URL of a1 -> must be de-duped by document_id
  {
    source: { name: "Aggregator" },
    title: "Repost: outage story",
    url: "https://example.com/a1",
    publishedAt: "2024-10-15T09:00:00Z",
    content: "x",
  },
];

const NEWS_GENERIC = [
  {
    source: { name: "PR Newswire" },
    title: "Amazon announces new fulfillment center opening in Q4",
    description: "The company will open a new facility, adding jobs.",
    url: "https://example.com/g1",
    publishedAt: "2024-10-10T09:00:00Z",
    content: "Executives highlighted continued investment. [+300 chars]",
  },
  {
    source: { name: "MarketWatch" },
    title: "Analysts weigh in ahead of Amazon earnings",
    description: "Expectations are mixed heading into the print.",
    url: "https://example.com/g2",
    publishedAt: "2024-10-12T09:00:00Z",
    content: "Several analysts raised price targets. [+250 chars]",
  },
];

// GNews v4/search -> body.articles[].  Same shape as NewsAPI except source is
// { name, url } (no id) and content is truncated WITHOUT a "[+N chars]" marker.
const GNEWS_BUG_CLUSTER = [
  {
    source: { name: "Reuters", url: "https://www.reuters.com" },
    title: "Shopify outage traced to software bug crashing checkout",
    description: "A software bug caused a widespread outage across merchants.",
    url: "https://example.com/gn1",
    image: "https://img.example.com/1.jpg",
    publishedAt: "2024-10-15T09:00:00Z",
    content: "The outage left customers unable to check out during peak hours...",
  },
  {
    source: { name: "TechCrunch", url: "https://techcrunch.com" },
    title: "Merchants hit by login errors and crashes after botched patch",
    description: "Users report repeated login errors and app crashes.",
    url: "https://example.com/gn2",
    image: "https://img.example.com/2.jpg",
    publishedAt: "2024-10-16T11:00:00Z",
    content: "A patch appears to have introduced a defect that breaks sync...",
  },
  {
    source: { name: "The Verge", url: "https://www.theverge.com" },
    title: "Sync failure and server error persist for Shopify sellers",
    description: "A sync failure and server error disrupted seller tools.",
    url: "https://example.com/gn3",
    image: "https://img.example.com/3.jpg",
    publishedAt: "2024-10-17T08:30:00Z",
    content: "Sellers could not update inventory during the downtime...",
  },
  // duplicate URL of gn1 -> must be de-duped by document_id
  {
    source: { name: "Aggregator", url: "https://agg.example.com" },
    title: "Repost: outage story",
    url: "https://example.com/gn1",
    publishedAt: "2024-10-15T09:00:00Z",
    content: "x",
  },
];

/* --------------------------------------------------------------- shared-tagger tests */

test("themes: periodFromDate handles both date shapes", () => {
  assert.equal(periodFromDate("2024-09-28"), "2024-09");
  assert.equal(periodFromDate("2024-10-31 17:00:00"), "2024-10");
  assert.equal(periodFromDate("2024-10-15T09:00:00Z"), "2024-10");
  assert.equal(periodFromDate("garbage"), "");
});

test("themes: tagThemes maps real phrasing to the four engine themes", () => {
  assert.deepEqual(tagThemes("A software bug caused a widespread outage").sort(), ["software_bug"]);
  assert.ok(tagThemes("shipping delay in the logistics network").includes("shipping_delay"));
  assert.ok(tagThemes("the product arrived damaged and flimsy").includes("product_quality"));
  assert.ok(tagThemes("customers switched to a competitor").includes("competitor"));
  assert.deepEqual(tagThemes("a perfectly neutral sentence"), []);
});

test("themes: isNegative flags negative text and low ratings", () => {
  assert.equal(isNegative("this was a terrible, disappointing experience"), true);
  assert.equal(isNegative("great product, loved it"), false);
  assert.equal(isNegative("neutral", 2), true);
  assert.equal(isNegative("neutral", 5), false);
});

/* --------------------------------------------------------------- FMP normalizers */

test("fmp: normalizeIncome -> 3 KPIs per quarter at region Total, period_type quarter", () => {
  const rows = normalizeIncome(INCOME, "AMZN");
  assert.equal(rows.length, 9); // 3 quarters x {revenue, gross_profit, operating_expenses}
  for (const r of rows) {
    assert.equal(r.company, "AMZN");
    assert.equal(r.region, "Total");
    assert.equal(r.period_type, "quarter");
    assert.match(r.period, /^\d{4}-\d{2}$/);
    assert.equal(typeof r.value, "number");
    assert.ok(["revenue", "gross_profit", "operating_expenses"].includes(r.kpi_key));
  }
  const rev = rows.find((r) => r.kpi_key === "revenue" && r.period === "2024-09");
  assert.equal(rev?.value, 158877000000);
});

test("fmp: normalizeGeo -> revenue per sanitized region ('… Segment' stripped)", () => {
  const rows = normalizeGeo(GEO, "AMZN");
  assert.equal(rows.length, 4); // 2 quarters x 2 regions
  const regions = new Set(rows.map((r) => r.region));
  assert.deepEqual([...regions].sort(), ["International", "United States"]);
  for (const r of rows) {
    assert.equal(r.kpi_key, "revenue");
    // Geographic segmentation is filed ANNUALLY — labelling it "quarter" is what
    // leaked annual-only periods into the quarterly period dropdown.
    assert.equal(r.period_type, "annual");
  }
});

test("fmp: canonicalRegion merges naming drift but preserves distinct segments", () => {
  // The same JPM region, spelled two ways across filing years -> one label.
  assert.equal(canonicalRegion("Europe/Middle East/Africa"), "EMEA");
  assert.equal(canonicalRegion("EMEA"), "EMEA");
  assert.equal(canonicalRegion("Asia-Pacific"), "Asia-Pacific");
  assert.equal(canonicalRegion("Asia Pacific"), "Asia-Pacific");
  assert.equal(canonicalRegion("Latin America/Caribbean"), "Latin America");
  assert.equal(canonicalRegion("Latin America"), "Latin America");
  assert.equal(canonicalRegion("North America"), "North America");
  // Genuinely different segments must NOT be collapsed into each other.
  assert.equal(canonicalRegion("United States Segment"), "United States");
  assert.equal(canonicalRegion("International Segment"), "International");
  assert.equal(canonicalRegion("Europe"), "Europe");
  assert.equal(canonicalRegion(""), "Unknown");
});

test("fmp: normalizeGeo collapses drifted labels and sums same-period duplicates", () => {
  const drifted = [
    { date: "2019-12-31", data: { "Asia-Pacific": 100, "Europe/Middle East/Africa": 200 } },
    { date: "2020-12-31", data: { "Asia Pacific": 150, EMEA: 250 } },
    // one region split across two lines in the same filing -> must SUM, not duplicate
    { date: "2021-12-31", data: { "Latin America": 10, "Latin America/Caribbean": 5 } },
  ];
  const rows = normalizeGeo(drifted, "JPM");
  const regions = [...new Set(rows.map((r) => r.region))].sort();
  assert.deepEqual(regions, ["Asia-Pacific", "EMEA", "Latin America"]);

  // 2019 + 2020 both land on the SAME two region labels -> a 2-point series each,
  // which is the whole point: no phantom half-length regions.
  const apac = rows.filter((r) => r.region === "Asia-Pacific").map((r) => r.period).sort();
  assert.deepEqual(apac, ["2019-12", "2020-12"]);

  // duplicates within one period are summed into a single row (no repeated period)
  const latam = rows.filter((r) => r.region === "Latin America");
  assert.equal(latam.length, 1);
  assert.equal(latam[0].value, 15);
});

test("fmp: normalizeTranscripts -> one namespaced earnings_transcript doc, themed", () => {
  const docs = normalizeTranscripts(TRANSCRIPTS, "AMZN");
  assert.equal(docs.length, 1);
  const d = docs[0];
  assert.equal(d.document_id, "AMZN-transcript-2024-10");
  assert.equal(d.type, "earnings_transcript");
  assert.equal(d.region, "Total");
  assert.equal(d.source, "fmp");
  assert.ok(d.text.startsWith("Earnings call (Q3 2024)."));
  assert.ok(d.themes.includes("shipping_delay"));
});

/* --------------------------------------------------------------- NewsAPI normalizer */

test("news: normalizeArticles -> namespaced docs, de-duped, '[+N chars]' stripped", () => {
  const docs = normalizeArticles(NEWS_BUG_CLUSTER, "AMZN");
  assert.equal(docs.length, 4); // 5 in, 1 duplicate URL removed
  for (const d of docs) {
    assert.equal(d.company, "AMZN");
    assert.equal(d.type, "news");
    assert.equal(d.region, "Total");
    assert.equal(d.source, "newsapi");
    assert.ok(d.document_id.startsWith("AMZN-news-"));
    assert.doesNotMatch(d.text, /\[\+\d+ chars\]/); // truncation marker removed
  }
  // category is the NewsAPI source name
  assert.ok(docs.some((d) => d.category === "Reuters"));
  // the cluster is unmistakably a software-bug story
  const bugDocs = docs.filter((d) => d.themes.includes("software_bug"));
  assert.ok(bugDocs.length >= 3, `expected a software_bug cluster, got ${bugDocs.length}`);
});

/* --------------------------------------------------------------- GNews normalizer */

test("gnews: same normalizer stamps source='gnews' on GNews-shaped articles", () => {
  // GNews reuses normalizeArticles with the "gnews" label (see gnews.ts pullGnews).
  const docs = normalizeArticles(GNEWS_BUG_CLUSTER, "SHOP", "gnews");
  assert.equal(docs.length, 3); // 4 in, 1 duplicate URL removed
  for (const d of docs) {
    assert.equal(d.company, "SHOP");
    assert.equal(d.type, "news");
    assert.equal(d.region, "Total");
    assert.equal(d.source, "gnews"); // provenance label, not "newsapi"
    assert.ok(d.document_id.startsWith("SHOP-news-"));
  }
  // GNews' { source: { name } } still maps to category
  assert.ok(docs.some((d) => d.category === "Reuters"));
  // theme tagging is source-agnostic → still a software_bug cluster
  const bugDocs = docs.filter((d) => d.themes.includes("software_bug"));
  assert.ok(bugDocs.length >= 3, `expected a software_bug cluster, got ${bugDocs.length}`);
});

test("gnews: gnewsConfigured() is false without a key (module loads clean)", () => {
  // no GNEWS_API_KEY in the test env → guard returns false (also smoke-imports gnews.ts)
  assert.equal(gnewsConfigured(), false);
});

/* --------------------------------------------------------------- connector -> engine */

// Mirrors what retrieval.ts computes over stored docs: count each theme vs a baseline.
// Kept in the test so the assertion is that CONNECTOR OUTPUT feeds engine-shaped evidence.
function spikesFrom(docs: IngestDoc[], baseline = 0.4) {
  return THEMES.map((theme) => {
    const count = docs.filter((d) => d.themes.includes(theme)).length;
    const ratio = baseline ? +(count / baseline).toFixed(1) : count;
    return { theme, count, baseline, ratio, spiking: count >= 3 && ratio >= 3 };
  });
}

function confirmedDrivers(): DriverResult {
  return {
    by_recurring: [
      { key: "Software (subscription)", delta: -279578, pct_of_change: 108.1 },
      { key: "Physical goods", delta: 20000, pct_of_change: -8.1 },
    ],
    by_segment: [
      { key: "Enterprise", delta: -260000, pct_of_change: 95 },
      { key: "SMB", delta: -10000, pct_of_change: 4 },
    ],
    churn: {
      churned_count: 14,
      churned_arr: 2901984,
      by_reason: [{ reason: "software bug — repeated crashes/sync failures; accounts escalated to churn", count: 14, arr: 2901984 }],
    },
  } as unknown as DriverResult;
}

function calmDrivers(): DriverResult {
  return {
    by_recurring: [{ key: "Physical goods", delta: -113576, pct_of_change: 102.5 }],
    by_segment: [{ key: "Consumer", delta: -60000, pct_of_change: 53 }],
    churn: { churned_count: 0, churned_arr: 0, by_reason: [] },
  } as unknown as DriverResult;
}

const sigDown = { tier: "significant", zscore: -5.2, is_anomaly: true, direction: "down" } as AnomalyResult;

test("connector→engine: a real software-bug news cluster produces a CONFIRMED, high-confidence story", () => {
  const docs = normalizeArticles(NEWS_BUG_CLUSTER, "AMZN");
  const spikes = spikesFrom(docs);
  const bug = spikes.find((s) => s.theme === "software_bug")!;
  assert.equal(bug.spiking, true); // evidence derived purely from connector output

  const retrieval = { theme_spikes: spikes } as unknown as RetrievalResult;
  const c = scoreConfidence(sigDown, confirmedDrivers(), retrieval);
  assert.equal(c.label, "High");
  assert.equal(c.ambiguity.flag, false);
  assert.equal(c.aligned_theme, "software_bug");
});

test("connector→engine: generic news with no theme cluster stays AMBIGUOUS / low-confidence", () => {
  const docs = normalizeArticles(NEWS_GENERIC, "AMZN");
  const spikes = spikesFrom(docs);
  assert.ok(spikes.every((s) => !s.spiking)); // no cluster in the connector output

  const retrieval = { theme_spikes: spikes } as unknown as RetrievalResult;
  const c = scoreConfidence(sigDown, calmDrivers(), retrieval);
  assert.equal(c.label, "Low");
  assert.equal(c.ambiguity.flag, true);
});

/* --------------------------------------------------------------- shape guard */

test("shapes: normalized rows satisfy the IngestKpiValue / IngestDoc contracts", () => {
  const kvs: IngestKpiValue[] = [...normalizeIncome(INCOME, "AMZN"), ...normalizeGeo(GEO, "AMZN")];
  for (const k of kvs) {
    for (const f of ["company", "kpi_key", "region", "period", "period_type", "value"] as const) {
      assert.ok(k[f] !== undefined && k[f] !== null, `KpiValue missing ${f}`);
    }
  }
  const docs: IngestDoc[] = [...normalizeTranscripts(TRANSCRIPTS, "AMZN"), ...normalizeArticles(NEWS_BUG_CLUSTER, "AMZN")];
  for (const d of docs) {
    for (const f of ["company", "document_id", "type", "period", "region", "text", "source"] as const) {
      assert.ok(d[f] !== undefined && d[f] !== null && d[f] !== "", `Doc missing ${f}`);
    }
    assert.ok(Array.isArray(d.themes));
    assert.equal(typeof d.negative, "boolean");
  }
});

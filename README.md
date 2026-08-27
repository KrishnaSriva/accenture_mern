# KPI Storytelling Engine

Detects meaningful KPI changes, finds the likely root cause from structured + unstructured
data, explains it in plain language with a confidence score, and recommends actions.

**Stack:** React + TypeScript + Tailwind (client) · Node + Express + TypeScript (server) ·
MongoDB (Mongoose) · OpenAI (embeddings + narration, with deterministic fallbacks) ·
live connectors for **Financial Modeling Prep** (financials) and **news** (NewsAPI or GNews).

The app is **multi-tenant by company**. It ships with a built-in synthetic **DEMO** company
(the Amazon-modeled story below) and can **connect a real public company by ticker** in one
click, pulling its data live from the cloud. The DEMO tenant always stays intact.

## Demo story baked into the seed data

- **High-confidence:** EMEA revenue falls ~9% in **2025-11**. Root cause: enterprise software
  **renewals churn ~20%** (stable price → lost volume), corroborated by a spike of **Bug #402**
  crash reports across support tickets, CRM notes and reviews.
- **Ambiguous (low-confidence):** APAC revenue dips ~8% in **2025-06** with **no** supporting
  signal — the engine flags the cause as unconfirmed (correlation ≠ causation).

## Setup

Prerequisites: **Python 3** (numpy, pandas), **Node 18+**, and **MongoDB** running locally
(or a MongoDB Atlas URI).

### 1) Generate the seed data (deterministic, offline)

```bash
cd kpi-storytelling
python scripts/generate_data.py
python scripts/verify_data.py        # proves the demo story holds (statistical checks)
python scripts/verify_engine.py      # proves the ENGINE verdicts hold (EMEA→Confirmed, APAC→Ambiguous)
```

### 2) Backend — load the database and start the API

```bash
cd server
cp .env.example .env                 # optional: set OPENAI_API_KEY for AI narration; edit Mongo URI if needed
npm install
npm run seed                         # wipes + loads data/generated/*.json into MongoDB
npm run embed                        # builds document embeddings (OpenAI if key set, else offline hashing)
npm run dev                          # API on http://localhost:4000
```

Check it worked:

```bash
curl http://localhost:4000/api/health
# { "ok": true, "counts": { "regions": 4, "kpis": 6, "kpiValues": 576, ... } }
```

### 3) Frontend — the dashboard

```bash
cd client
npm install
npm run dev                          # app on http://localhost:5173 (proxies /api to :4000)
```

Open http://localhost:5173. It auto-loads the **EMEA · Nov 2025** story; the sidebar has a
**company switcher**, a **Connect a company** box (ticker → live data), both demo scenarios, and
a **Scan** button that ranks every region for the selected metric/period.

> **No OpenAI key?** Everything still works. Embeddings fall back to a deterministic offline
> method and narration falls back to a deterministic template. A key only upgrades the prose.

## Connect a real company (live data)

Type a ticker (e.g. `AMZN`, `NKE`, `SHOP`) into the sidebar and click **Connect**. The backend
pulls that public company's data straight from the cloud, normalizes it into the same collections
the engine already uses, embeds the new documents, and runs the identical analysis pipeline:

```
POST /api/connect { ticker }
   → FMP:  quarterly income statement (revenue / gross profit / operating expenses),
           geographic revenue segments, earnings-call transcripts
   → News: recent articles from NewsAPI and/or GNews (theme-tagged for the four engine themes)
   → normalize → merge + de-dupe → replace this company's rows (idempotent) → embed → analyze
```

Enable it by adding keys to `server/.env`, then restart the API:

```bash
FMP_API_KEY=...      # https://site.financialmodelingprep.com/developer/docs
NEWSAPI_KEY=...      # https://newsapi.org        (signup requires a WORK email)
GNEWS_API_KEY=...    # https://gnews.io           (free tier accepts a PERSONAL email)
```

Set **any** of these. `NEWSAPI_KEY` and `GNEWS_API_KEY` are interchangeable news sources —
GNews is the easy self-serve option, since NewsAPI's signup requires a work email.

**Free-tier caveats (by design, the engine degrades gracefully):**

- FMP's **income statement** is broadly available on the free tier; **geographic segmentation**
  and **transcripts** are paid — without them a company analyzes at the `Total` region with
  financials-only signal.
- **News** history is limited on free tiers (NewsAPI serves **~1 month**; GNews caps at **10
  articles** per request and truncates content), so the 12-month theme baseline is thin for
  news-only companies — the engine (correctly) stays cautious unless a clear in-month cluster
  appears.
- Set **any** of the keys. With none, Connect is disabled and the DEMO company still works.

Everything the engine reads is scoped by a `company` field, so real companies and the synthetic
DEMO coexist. This connects **public** data keyed by ticker; wiring a company's **private** systems
(CRM/ERP/support via OAuth) is the same normalize → store → embed → analyze path with new fetchers.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | row counts, sanity check |
| GET | `/api/kpis` · `/regions` · `/periods` | catalogs for the controls (accept `?company=`) |
| GET | `/api/kpi-values?kpi=&region=` | raw time series (accepts `?company=`) |
| POST | `/api/analyze` `{kpi, region, period, company?}` | full analysis: change → drivers → evidence → confidence → story |
| GET | `/api/scan?kpi=&period=&company=` | all regions ranked by \|z\| |
| GET | `/api/analysis?kpi=&region=&period=&company=` | cached analysis result |
| POST | `/api/connect` `{ticker}` | pull a real public company's data live and ingest it |
| GET | `/api/companies` | connected companies + which live sources are configured |

Every data/analysis route defaults to `company="DEMO"` when the parameter is omitted, so the demo
works with no changes.

## How the analysis works

```
detect anomaly  →  decompose drivers  →  retrieve evidence  →  score confidence  →  build story
  (modified z on      (category/segment/      (theme spikes vs      (structured ↔          (structured facts;
   month-over-month     software·physical,      12-mo baseline;       unstructured           LLM only narrates,
   % change series)     price-volume bridge,    embedding/lexical     agreement; caps        never invents)
                        churn-by-reason)        doc ranking)          confidence when
                                                                      cause unconfirmed)
```

The **confidence** score is about explaining the *cause*, not just locating the change. When a
move is a real outlier but nothing corroborates a cause (no theme spike, no churn), the engine
**caps confidence and flags ambiguity** — that is the APAC case, and it is the honesty guarantee.

## Tests

```bash
cd server
npm test        # pure-logic unit tests, no DB/network required
```

Covers the engine's robust stats + confidence contract (EMEA→Confirmed, APAC→Ambiguous) and the
live connectors: the FMP / NewsAPI / GNews normalizers are exercised against real-shaped fixtures,
and connector output is fed through the real confidence scorer to prove a bug-news cluster yields a
**confirmed** story while generic news stays **ambiguous**. The end-to-end pipeline against the
seed data is proven by `scripts/verify_engine.py`.

## Bringing in your own raw files

Besides the live **Connect** flow, you can drop a real export into `data/raw/`, map rows into the
`documents` collection (tag `company`), and re-run `npm run embed`. The structured KPIs + Bug #402
layer are synthesized by `scripts/generate_data.py` regardless, so the DEMO story stays intact.

## Layout

```
kpi-storytelling/
  scripts/        generate_data.py, verify_data.py, verify_engine.py   (offline generation + checks)
  data/generated/ *.json                               (seed data)
  data/raw/       (drop real exports here)
  server/         Express + TS API, Mongoose models, engine (anomaly, drivers, retrieval,
                  confidence, story, pipeline), ingest connectors (themes, fmp, news, gnews,
                  connect), seed + embed loaders, unit tests
  client/         React + TS + Tailwind dashboard (company switcher + Connect box)
```

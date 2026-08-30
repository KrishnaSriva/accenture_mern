# KPI Storytelling Engine

* **Live Site:** [https://accenture-mern.vercel.app/](https://accenture-mern.vercel.app/)
* **Backend API:** [https://accenture-mern-1.onrender.com/api](https://accenture-mern-1.onrender.com/api)

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
cd accenture_mern
python scripts/generate_data.py
python scripts/verify_data.py        # proves the demo story holds (statistical checks)
python scripts/verify_engine.py      # proves the ENGINE verdicts hold (EMEA→Confirmed, APAC→Ambiguous)
```

### 2) Backend — load the database and start the API

```bash
cd server
cp .env.example .env                 # all keys optional; Gemini has a free tier, or leave blank
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

> **No API key?** Everything still works. Embeddings fall back to a deterministic offline
> method and narration falls back to a deterministic template. A key only upgrades the prose —
> set `GEMINI_API_KEY` (free tier) or `OPENAI_API_KEY` (paid); Gemini wins if both are present.

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
detect anomaly  →  decompose drivers  →  retrieve evidence  →  score confidence  →  rank hypotheses
  (modified z on      (category/segment/      (theme spikes vs      (structured ↔        (every cause the data
   month-over-month     software·physical,      12-mo baseline;       unstructured         could support, each with
   % change series)     price-volume bridge,    embedding/lexical     agreement; caps      the test that would
                        churn-by-reason;        doc ranking)          confidence when      disconfirm it)
                        margin bridge and                            cause unconfirmed)
                        segment mix for
                        reported totals)
        ↓
validate a forecast  →  gate a recovery scenario  →  build an action plan  →  narrate  →  audit trail
  (rolling-origin          (open only when a cause      (owner, time-to-signal,   (LLM only    (every figure,
   backtest picks the       is confirmed AND a driver     falsifiable check, and    rewrites     its formula,
   method and sizes the     was actually sized)           the measured amount       the facts)   and the rows
   interval — or refuses)                                 each action addresses)                 it came from)
```

The **confidence** score is about explaining the *cause*, not just locating the change. When a
move is a real outlier but nothing corroborates a cause (no theme spike, no churn), the engine
**caps confidence and flags ambiguity** — that is the APAC case, and it is the honesty guarantee.
Evidence that only *locates* a change cannot lift the score past 62; external news alone cannot
lift it past 44.

### The forecast refuses more often than it draws

A dashboard that extrapolates a low-confidence series is the failure mode this project exists to
fix, so nothing forward-looking is drawn unless the server proved it first:

- Four candidate methods (carry-forward, drift, seasonal naive, seasonal drift) compete in a
  **rolling-origin backtest**; the winner is the one with the lowest out-of-sample median APE.
- The published band is the **empirical 80% interval** taken from that method's own backtest
  errors — not a formula, and widened by √h where a horizon had too few folds to measure.
- The horizon is capped by the data (`floor(n/4)`, never more than 3), the drift is clamped, and
  coverage is checked walk-forward against the 80% target.
- It **declines** on fewer than 8 periods, on an irregular calendar, and when one-step error
  exceeds 20% — and prints the reason where the line would have been.

### The recovery slider is gated, not decorative

The slider moves a share of a **loss the driver decomposition actually measured** onto the
validated baseline. It is disabled with a written reason when there is no forecast to move, when
the move was favourable, when the cause is only a leading hypothesis rather than a confirmed one,
or when no driver could be sized. `formula` and `basis` are shown alongside it.

### Show the math

Every figure in the story has an entry in the **audit trail**: the question it answers, the
method, the formula, each input with the collection it came from, and the result — or, where the
engine declined, the reason it withheld one. This is what makes the claim "the LLM never invents a
number" checkable rather than asserted.

## Tests

```bash
cd server
npm test                      # pure-logic unit tests, no DB/network required

# or, with zero dependencies installed (needs Node >= 22.6):
bash scripts/test_no_install.sh
```

74 tests, no database, no network, no API key. They cover the robust stats and the confidence
contract (EMEA→Confirmed, APAC→Ambiguous); the forecast's **refusals** as hard as its outputs;
each of the recovery scenario's four gates; the action plan degrading to experiments under
ambiguity and to data collection when nothing ranks; the confidence ceilings; and a
**client/server contract suite** that reads `client/src/types.ts` and asserts every field the
dashboard renders is really present on the objects the engine builds. The live connectors are
exercised against real-shaped fixtures, and connector output is fed through the real confidence
scorer to prove a bug-news cluster yields a **confirmed** story while generic news stays
**ambiguous**. The end-to-end pipeline against the seed data is proven by
`scripts/verify_engine.py`.

## Bringing in your own raw files

Besides the live **Connect** flow, you can drop a real export into `data/raw/`, map rows into the
`documents` collection (tag `company`), and re-run `npm run embed`. The structured KPIs + Bug #402
layer are synthesized by `scripts/generate_data.py` regardless, so the DEMO story stays intact.

## Layout

```
accenture_mern/
  scripts/        generate_data.py, verify_data.py, verify_engine.py   (offline generation + checks)
                  test_no_install.sh                                   (unit tests, zero npm install)
  data/generated/ *.json                               (seed data)
  data/raw/       (drop real exports here)
  server/         Express + TS API, Mongoose models, engine (stats, anomaly, drivers, aggregate,
                  retrieval, confidence, hypotheses, forecast, scenario, actions, provenance,
                  story, pipeline), ingest connectors (themes, fmp, news, gnews, connect),
                  seed + embed loaders, unit tests
  client/         React + TS + Tailwind dashboard — chart with validated forecast band, story card,
                  confidence breakdown, hypothesis ledger, outlook + gated recovery scenario,
                  quantified action plan, evidence list, audit trail
```

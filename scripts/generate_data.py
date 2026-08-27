"""
Offline seed-data generator for the KPI Storytelling Engine.

Runs with only numpy + pandas (no network, no extra installs). It writes a set of
JSON files into ../data/generated/ that the Node seed loader inserts into MongoDB.

The dataset is modeled on a realistic Amazon-style catalog (real category taxonomy,
plausible prices, realistic review/ticket phrasing) and is engineered to tell one
clear story and one deliberately ambiguous one:

  DEMO (high confidence): EMEA revenue falls ~8% in 2025-11 because enterprise
  software renewals churn ~20% (stable price -> lost volume), corroborated by a
  spike of "Bug #402" support tickets, CRM notes and negative reviews in EMEA.

  AMBIGUOUS (low confidence): APAC revenue dips ~9% in 2025-06 with NO supporting
  customer/CRM signal -> the engine should flag the cause as unconfirmed.

Everything is deterministic (fixed RNG seed) so the story is reproducible.

To later use REAL Amazon data: drop an export into ../data/raw/ and extend
ingest (Phase 5) to map rows into the `documents` collection. The structured
KPIs + Bug #402 layer are synthesized here regardless.
"""

import json
from pathlib import Path
from datetime import datetime, timedelta

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "generated"
OUT.mkdir(parents=True, exist_ok=True)

rng = np.random.default_rng(7)

# ----------------------------------------------------------------------------- config
MONTHS = [f"{y}-{m:02d}" for y in (2024, 2025) for m in range(1, 13)]  # 24 months
REGIONS = [
    {"code": "NA", "name": "North America"},
    {"code": "EMEA", "name": "Europe, Middle East & Africa"},
    {"code": "APAC", "name": "Asia-Pacific"},
    {"code": "LATAM", "name": "Latin America"},
]
SEGMENTS = ["Enterprise", "SMB", "Consumer"]

DEMO_PERIOD, DEMO_REGION = "2025-11", "EMEA"
AMBIG_PERIOD, AMBIG_REGION = "2025-06", "APAC"

CHURN_DROP = 0.20        # EMEA enterprise renewal churn spike in demo month
AMBIG_DROP = 0.12        # APAC physical revenue dip in ambiguous month

# Software (subscription) share of each region's revenue in a normal month.
# EMEA ~0.45 so a ~20% renewal churn nets to ~8% of total revenue after the
# month's normal physical growth offset.
SOFTWARE_SHARE = {"NA": 0.35, "EMEA": 0.45, "APAC": 0.25, "LATAM": 0.20}

# Baseline monthly PHYSICAL revenue per region (USD), before growth/seasonality/noise.
BASE_PHYSICAL = {"NA": 1_800_000, "EMEA": 1_200_000, "APAC": 900_000, "LATAM": 500_000}

# Mild seasonality (amplitude kept small so normal month-over-month swings stay
# well under the ~8% demo event — otherwise the holiday swing masks the signal).
SEASONALITY = {1: 0.985, 2: 0.98, 3: 1.00, 4: 1.00, 5: 1.005, 6: 1.00,
               7: 0.995, 8: 0.995, 9: 1.005, 10: 1.015, 11: 1.02, 12: 1.03}

# ----------------------------------------------------------------------------- catalog
# category, subscription?, base monthly price (software) or unit price (physical)
PRODUCTS = [
    # Enterprise software line -> renewals + the Bug #402 story
    {"sku": "SW-CLOUD-PRO",  "name": "Nimbus CloudSuite Pro",         "category": "Software",        "subscription": True,  "price": 1500},
    {"sku": "SW-CLOUD-ENT",  "name": "Nimbus CloudSuite Enterprise",  "category": "Software",        "subscription": True,  "price": 4200},
    {"sku": "SW-ANALYTICS",  "name": "Nimbus Analytics Add-on",       "category": "Software",        "subscription": True,  "price": 600},
    # Physical Amazon-style goods
    {"sku": "EL-LAPTOP-14",  "name": "Aero UltraBook 14",             "category": "Electronics",     "subscription": False, "price": 980},
    {"sku": "EL-MONITOR-27", "name": "Vivid 27\" 4K Monitor",         "category": "Electronics",     "subscription": False, "price": 320},
    {"sku": "EL-EARBUDS",    "name": "Buzz Wireless Earbuds",         "category": "Electronics",     "subscription": False, "price": 85},
    {"sku": "EL-WEBCAM-4K",  "name": "PulseCam 4K Webcam",            "category": "Electronics",     "subscription": False, "price": 70},
    {"sku": "HK-COFFEE",     "name": "BrewMax Drip Coffee Maker",     "category": "Home & Kitchen",  "subscription": False, "price": 95},
    {"sku": "HK-BLENDER",    "name": "ChopPro High-Speed Blender",    "category": "Home & Kitchen",  "subscription": False, "price": 130},
    {"sku": "OF-DESK",       "name": "ErgoDesk Standing Desk",        "category": "Office Products", "subscription": False, "price": 410},
    {"sku": "OF-CHAIR",      "name": "ErgoDesk Mesh Chair",           "category": "Office Products", "subscription": False, "price": 240},
    {"sku": "OF-MOUSE",      "name": "GlideMouse Wireless",           "category": "Office Products", "subscription": False, "price": 35},
]
PHYSICAL = [p for p in PRODUCTS if not p["subscription"]]
SOFTWARE = [p for p in PRODUCTS if p["subscription"]]
PHYS_WEIGHTS = np.array([1.4, 1.2, 1.6, 1.1, 1.0, 0.9, 1.0, 0.8, 1.3])  # relative popularity (9 physical SKUs)
PHYS_WEIGHTS = PHYS_WEIGHTS / PHYS_WEIGHTS.sum()

KPIS = [
    {"key": "revenue",         "name": "Revenue",           "unit": "USD",    "higher_is_better": True},
    {"key": "orders",          "name": "Orders",            "unit": "count",  "higher_is_better": True},
    {"key": "units",           "name": "Units Sold",        "unit": "count",  "higher_is_better": True},
    {"key": "renewal_arr",     "name": "Renewed ARR",       "unit": "USD",    "higher_is_better": True},
    {"key": "marketing_spend", "name": "Marketing Spend",   "unit": "USD",    "higher_is_better": False},
    {"key": "web_traffic",     "name": "Website Traffic",   "unit": "visits", "higher_is_better": True},
]

# ----------------------------------------------------------------------------- helpers
def month_index(period):
    return MONTHS.index(period)

def growth_factor(period, annual=0.15):
    """Gentle compounding growth across the 24-month window."""
    return (1 + annual) ** (month_index(period) / 12.0)

def month_int(period):
    return int(period.split("-")[1])

def a_day_in(period):
    y, m = (int(x) for x in period.split("-"))
    nxt = datetime(y + 1, 1, 1) if m == 12 else datetime(y, m + 1, 1)
    span = (nxt - datetime(y, m, 1)).days
    return (datetime(y, m, 1) + timedelta(days=int(rng.integers(0, span)))).strftime("%Y-%m-%d")

def new_id(prefix, n):
    return f"{prefix}-{n:06d}"

# ----------------------------------------------------------------------------- accounts + renewals
# Enterprise software accounts per region; each renews monthly (simplified MRR view).
# EMEA sees a churn spike in the demo month, most citing Bug #402.
ACCOUNTS_PER_REGION = {"NA": 90, "EMEA": 70, "APAC": 45, "LATAM": 25}
ACCOUNT_NAMES = [
    "Meridian", "Northwind", "Blue Harbor", "Vantage", "Ironclad", "Summit", "Kestrel",
    "Lumen", "Redwood", "Atlas", "Beacon", "Cobalt", "Delta", "Everest", "Fjord", "Granite",
    "Halcyon", "Indigo", "Juniper", "Kinetic", "Lattice", "Monarch", "Nimbus", "Onyx",
    "Pinnacle", "Quartz", "Ridge", "Sable", "Tundra", "Umbra", "Verde", "Willow",
]

def build_accounts_and_renewals():
    """Enterprise software accounts + monthly renewal outcomes.

    ARR is modeled as a smooth recurring STOCK (gentle upsell growth + tiny
    month noise), NOT a fresh random draw each month — so normal-month revenue is
    stable. The demo event is a PERSISTENT step-down: ~20% of EMEA accounts churn
    in the demo month citing Bug #402 and stay gone (no false rebound afterwards).
    """
    accounts, renewals = [], []
    aid, rid = 0, 0

    for region in REGIONS:
        rc = region["code"]
        for i in range(ACCOUNTS_PER_REGION[rc]):
            aid += 1
            plan = rng.choice(["SW-CLOUD-PRO", "SW-CLOUD-ENT"], p=[0.62, 0.38])
            seats = int(rng.integers(20, 400))
            fee = next(p["price"] for p in SOFTWARE if p["sku"] == plan)
            mrr = round(seats / 50 * fee, 2)  # scale fee by seat blocks
            name = f"{ACCOUNT_NAMES[(aid - 1) % len(ACCOUNT_NAMES)]} {rc}-{i+1:02d}"
            accounts.append({
                "account_id": new_id("ACC", aid), "name": name, "region": rc,
                "segment": "Enterprise", "plan_sku": plan, "seats": seats, "mrr": mrr,
            })

    for region in REGIONS:
        rc = region["code"]
        region_accounts = [a for a in accounts if a["region"] == rc]
        n = len(region_accounts)
        # deterministic demo-churn set: first ~20% of EMEA accounts, gone from demo month on
        demo_ids = set()
        if rc == DEMO_REGION:
            k = int(round(CHURN_DROP * n))
            demo_ids = {a["account_id"] for a in region_accounts[:k]}

        for period in MONTHS:
            month_noise = float(rng.normal(1.0, 0.005))  # small region-level smoothness
            for acc in region_accounts:
                is_demo = acc["account_id"] in demo_ids
                if is_demo and period > DEMO_PERIOD:
                    continue  # churned in the demo month and gone thereafter
                status, reason = "renewed", None
                if is_demo and period == DEMO_PERIOD:
                    status = "churned"
                    reason = "Bug #402 — repeated crashes/sync failures; account escalated to churn"
                rid += 1
                renewals.append({
                    "renewal_id": new_id("REN", rid), "account_id": acc["account_id"],
                    "account_name": acc["name"], "region": rc, "segment": "Enterprise",
                    "plan_sku": acc["plan_sku"], "period": period, "date": f"{period}-15",
                    "arr": round(acc["mrr"] * 12 * growth_factor(period) * month_noise, 2),
                    "status": status, "churn_reason": reason,
                })
    return accounts, renewals

# ----------------------------------------------------------------------------- physical + software sales rows
def build_sales(renewals):
    """Aggregated monthly sales rows at (region, period, sku, segment) grain.

    Physical goods are spread across products/segments to hit a per-region monthly
    revenue target. Software subscription revenue TRACKS renewed ARR (via a
    per-region calibration from that region's normal months), so the EMEA renewal
    churn in the demo month flows straight through into a revenue drop — instead of
    being renormalized away. Keeps the file small (~2.7k rows) and the price/volume
    bridge intact (units + revenue survive at every dimension).
    """
    rows, oid = [], 100000
    arr_df = _df(renewals)
    active = arr_df[arr_df["status"] == "renewed"].groupby(["region", "period"])["arr"].sum()
    renewed_accounts = arr_df[arr_df["status"] == "renewed"].groupby(["region", "period"]).size()

    # 1) physical revenue target per region/period (drawn once, deterministically)
    phys_target = {}
    for region in REGIONS:
        rc = region["code"]
        for period in MONTHS:
            t = BASE_PHYSICAL[rc] * SEASONALITY[month_int(period)] * growth_factor(period) \
                * float(rng.normal(1.0, 0.012))
            if rc == AMBIG_REGION and period == AMBIG_PERIOD:
                t *= (1 - AMBIG_DROP)          # ambiguous dip: physical drops, no narrative
            phys_target[(rc, period)] = t

    # 2) software calibration per region from its NORMAL months (exclude its special month),
    #    so software ≈ SOFTWARE_SHARE of the region total in a normal month.
    soft_scale = {}
    for region in REGIONS:
        rc = region["code"]
        share = SOFTWARE_SHARE[rc]
        special = DEMO_PERIOD if rc == DEMO_REGION else (AMBIG_PERIOD if rc == AMBIG_REGION else None)
        norm = [p for p in MONTHS if p != special]
        avg_phys = float(np.mean([phys_target[(rc, p)] for p in norm]))
        avg_soft = float(np.mean([float(active.get((rc, p), 0.0)) / 12.0 for p in norm]))
        target_soft = avg_phys * share / (1 - share)
        soft_scale[rc] = (target_soft / avg_soft) if avg_soft > 0 else 0.0

    # 3) emit aggregated rows
    seg_share = {"Enterprise": 0.18, "SMB": 0.32, "Consumer": 0.50}
    for region in REGIONS:
        rc = region["code"]
        price_factor = 0.98 if rc in ("APAC", "LATAM") else 1.0  # mild regional pricing
        for period in MONTHS:
            t = phys_target[(rc, period)]
            for pidx, prod in enumerate(PHYSICAL):
                prod_rev = t * float(PHYS_WEIGHTS[pidx])
                for seg, sh in seg_share.items():
                    revenue = round(prod_rev * sh, 2)
                    if revenue <= 0:
                        continue
                    avg_discount = 0.05
                    avg_price = prod["price"] * price_factor
                    units = int(max(1, round(revenue / (avg_price * (1 - avg_discount)))))
                    orders = int(max(1, round(units / 2.0)))
                    oid += 1
                    rows.append({
                        "order_id": new_id("ORD", oid), "period": period, "date": f"{period}-15",
                        "region": rc, "sku": prod["sku"], "product": prod["name"],
                        "category": prod["category"], "segment": seg,
                        "orders": orders, "quantity": units,
                        "unit_price": round(avg_price, 2), "discount": avg_discount,
                        "revenue": revenue, "cost": round(revenue * 0.63, 2),
                        "profit": round(revenue * 0.37, 2), "recurring": False,
                    })

            # software subscription — ONE Enterprise/Software row that tracks renewed ARR
            soft_rev = round(float(active.get((rc, period), 0.0)) / 12.0 * soft_scale[rc], 2)
            n_acc = int(renewed_accounts.get((rc, period), 0))
            unit_price = round(soft_rev / n_acc, 2) if n_acc else 0.0
            oid += 1
            rows.append({
                "order_id": new_id("ORD", oid), "period": period, "date": f"{period}-15",
                "region": rc, "sku": "SW-CLOUDSUITE", "product": "Nimbus CloudSuite (subscriptions)",
                "category": "Software", "segment": "Enterprise",
                "orders": n_acc, "quantity": n_acc,
                "unit_price": unit_price, "discount": 0.0,
                "revenue": soft_rev, "cost": round(soft_rev * 0.25, 2),
                "profit": round(soft_rev * 0.75, 2), "recurring": True,
            })
    return rows

# ----------------------------------------------------------------------------- KPI values
def build_kpi_values(sales, renewals):
    s = _df(sales)
    kv = []

    # revenue / orders / units per region/period
    g = s.groupby(["region", "period"]).agg(
        revenue=("revenue", "sum"),
        orders=("orders", "sum"),
        units=("quantity", "sum"),
    ).reset_index()
    for _, r in g.iterrows():
        for key in ("revenue", "orders", "units"):
            kv.append(_kv(key, r["region"], r["period"], float(r[key])))

    # renewed ARR per region/period
    rn = _df(renewals)
    arr = rn[rn["status"] == "renewed"].groupby(["region", "period"])["arr"].sum().reset_index()
    for _, r in arr.iterrows():
        kv.append(_kv("renewal_arr", r["region"], r["period"], float(r["arr"])))

    # marketing spend + web traffic (steady, no injected anomaly) so the KPI picker has variety
    for region in REGIONS:
        rc = region["code"]
        for period in MONTHS:
            grow = growth_factor(period, 0.12)
            seas = SEASONALITY[month_int(period)]
            spend = BASE_PHYSICAL[rc] * 0.08 * seas * grow * float(rng.normal(1.0, 0.03))
            traffic = BASE_PHYSICAL[rc] / 20 * seas * grow * float(rng.normal(1.0, 0.03))
            kv.append(_kv("marketing_spend", rc, period, round(spend, 2)))
            kv.append(_kv("web_traffic", rc, period, round(traffic)))
    return kv

def _kv(key, region, period, value):
    return {"kpi_key": key, "region": region, "period": period,
            "period_type": "month", "value": round(value, 2)}

# ----------------------------------------------------------------------------- inventory
def build_inventory(sales):
    """Monthly stock snapshot per region/product; EMEA software n/a (subscription)."""
    inv, iid = [], 0
    for region in REGIONS:
        rc = region["code"]
        for period in MONTHS:
            for prod in PHYSICAL:
                iid += 1
                on_hand = int(max(0, rng.normal(500, 90)))
                stockouts = int(max(0, rng.poisson(1.2)))
                inv.append({
                    "inventory_id": new_id("INV", iid), "period": period, "region": rc,
                    "sku": prod["sku"], "product": prod["name"], "units_on_hand": on_hand,
                    "stockout_events": stockouts,
                })
    return inv

# ----------------------------------------------------------------------------- documents (unstructured)
POSITIVE = [
    "Works exactly as described, rollout was smooth and the team is happy.",
    "Great value, our staff picked it up quickly with no issues.",
    "Reliable and fast, no complaints after months of daily use.",
    "Solid product, setup was painless and support was responsive.",
]
NEUTRAL = [
    "It's fine overall, does the job but nothing stands out.",
    "Average experience, onboarding took a little longer than expected.",
]
BUG_402 = [
    "Since the last update we keep hitting Bug #402 — the app crashes on login and we lose work.",
    "Bug #402 is killing us: constant sync failures and freezes, several teams can't work.",
    "CloudSuite throws error 402 repeatedly, dashboards won't load and data stops saving.",
    "We've logged Bug #402 three times this week — crashes every morning, this is unacceptable.",
    "The 402 crash bug makes the product unusable for us; we're evaluating alternatives.",
    "Bug #402 again — login loop and lost sessions. If this isn't fixed we won't renew.",
]
SHIPPING = [
    "Order arrived a week late with no tracking updates.",
    "Delivery was delayed and support was slow to respond.",
]
QUALITY = [
    "Arrived with a defect and had to request a replacement.",
    "Build quality feels cheaper than expected for the price.",
]

def tag_themes(text):
    low = text.lower()
    themes = set()
    if "402" in low or "crash" in low or "login" in low or "sync" in low or "freeze" in low or "error" in low:
        themes.add("software_bug")
    if "late" in low or "delivery" in low or "tracking" in low or "delayed" in low:
        themes.add("shipping_delay")
    if "defect" in low or "quality" in low or "replacement" in low or "broken" in low:
        themes.add("product_quality")
    if "renew" in low or "alternativ" in low or "evaluating" in low:
        themes.add("competitor")
    return sorted(themes)

def _doc(did, dtype, period, region, category, text, **extra):
    d = {"document_id": new_id("DOC", did), "type": dtype, "period": period,
         "date": a_day_in(period), "region": region, "category": category,
         "text": text, "themes": tag_themes(text)}
    d["negative"] = bool(set(d["themes"]) & {"software_bug", "shipping_delay", "product_quality", "competitor"})
    d.update(extra)
    return d

def _bug_intensity(region, period):
    """How many Bug #402 docs to emit. Baseline low; EMEA spikes Oct->Nov 2025."""
    if region != DEMO_REGION:
        return 0.03  # tiny background rate elsewhere
    if period == DEMO_PERIOD:
        return 1.0                      # full spike
    if period == "2025-10":
        return 0.35                     # early tremors the month before
    return 0.03

def build_documents():
    docs, did = [], 0

    for region in REGIONS:
        rc = region["code"]
        for period in MONTHS:
            n_reviews = int(rng.integers(30, 46))
            bug_rate = _bug_intensity(rc, period)
            for _ in range(n_reviews):
                if rng.random() < bug_rate * 0.5:
                    text, cat, rating = pick(BUG_402), "Software", int(rng.choice([1, 2]))
                else:
                    r = rng.choice([5, 4, 3, 2, 1], p=[0.45, 0.30, 0.13, 0.08, 0.04])
                    cat = rng.choice(["Electronics", "Home & Kitchen", "Office Products", "Software"],
                                     p=[0.4, 0.25, 0.25, 0.1])
                    text = pick(POSITIVE) if r >= 4 else pick(NEUTRAL) if r == 3 else pick(QUALITY + SHIPPING)
                    rating = int(r)
                did += 1
                docs.append(_doc(did, "review", period, rc, cat, text, rating=rating, source="amazon_review"))

            # support tickets — baseline mix + Bug #402 spike in EMEA demo month (+~35%)
            base_tickets = int(round(24 * SEASONALITY[month_int(period)]))
            extra_bug = int(round(base_tickets * 0.35)) if (rc == DEMO_REGION and period == DEMO_PERIOD) else 0
            for _ in range(base_tickets):
                text = pick(SHIPPING + QUALITY + NEUTRAL)
                did += 1
                docs.append(_doc(did, "support_ticket", period, rc,
                                 rng.choice(["Electronics", "Home & Kitchen", "Office Products"]),
                                 text, priority=str(rng.choice(["Low", "Medium", "High"])), status="Resolved"))
            for _ in range(extra_bug + (int(round(base_tickets * bug_rate)) if bug_rate >= 0.35 else 0)):
                did += 1
                docs.append(_doc(did, "support_ticket", period, rc, "Software", pick(BUG_402),
                                 priority="High", status=str(rng.choice(["Open", "Escalated"]))))

            # CRM notes — EMEA account managers flag Bug #402 churn risk in Oct/Nov 2025
            for _ in range(2):
                if rc == DEMO_REGION and period in (DEMO_PERIOD, "2025-10"):
                    text = pick([
                        "Two enterprise accounts escalated Bug #402 crashes; both threatening not to renew.",
                        "Account cited Bug #402 instability as the reason for downgrading their contract.",
                        "Renewal at risk: customer blocked on Bug #402, engineering ETA still unclear.",
                    ])
                else:
                    text = pick([
                        "Pipeline steady, renewals tracking to plan this month.",
                        "Healthy quarter-to-date, no red flags from key accounts.",
                    ])
                did += 1
                docs.append(_doc(did, "crm_note", period, rc, "Software", text, author="Account Mgmt"))

            # field sales notes
            if rc == DEMO_REGION and period == DEMO_PERIOD:
                did += 1
                docs.append(_doc(did, "sales_note", period, rc, "Software",
                                 "Lost two renewals this month to Bug #402 fallout; others want a fix date before committing.",
                                 author="Field Sales"))

    return docs

def pick(pool):
    return pool[int(rng.integers(0, len(pool)))]

# ----------------------------------------------------------------------------- users
def build_users():
    return [
        {"name": "Demo Analyst", "email": "analyst@demo.local", "role": "analyst"},
        {"name": "Demo Exec", "email": "exec@demo.local", "role": "viewer"},
    ]

# ----------------------------------------------------------------------------- util
import pandas as pd
def _df(rows):
    return pd.DataFrame(rows)

def dump(name, obj):
    path = OUT / f"{name}.json"
    with open(path, "w") as f:
        json.dump(obj, f, default=str)
    print(f"  {name:20s} {len(obj):6d} docs -> {path.relative_to(ROOT)}")

# ----------------------------------------------------------------------------- main
def main():
    print("Generating seed data...")
    accounts, renewals = build_accounts_and_renewals()
    sales = build_sales(renewals)
    kpi_values = build_kpi_values(sales, renewals)
    inventory = build_inventory(sales)
    documents = build_documents()

    dump("regions", REGIONS)
    dump("kpis", KPIS)
    dump("products", PRODUCTS)
    dump("users", build_users())
    dump("accounts", accounts)
    dump("renewals", renewals)
    dump("sales", sales)
    dump("kpi_values", kpi_values)
    dump("inventory", inventory)
    dump("documents", documents)
    print("Done.")

if __name__ == "__main__":
    main()

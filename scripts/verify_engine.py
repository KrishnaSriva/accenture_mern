#!/usr/bin/env python3
"""
verify_engine.py — offline proof that the ENGINE logic (not just the raw data)
produces the intended outcomes, by porting the exact TypeScript thresholds and
running them against data/generated/*.json.

The sandbox can't run Node/Mongo, so this mirrors:
  stats.modifiedZ / tierOf, anomaly.detectAt, drivers.decomposeBy + churnBreakdown,
  retrieval.themeSpikes, confidence.scoreConfidence

Asserts:
  A) EMEA / revenue / 2025-11  -> significant DOWN, cause CONFIRMED, confidence High,
                                   software the dominant negative driver, Bug #402 churn,
                                   software_bug theme spiking.
  B) APAC / revenue / 2025-06  -> significant, but AMBIGUOUS (no corroboration/churn),
                                   confidence Low.
Exit code != 0 if any assertion fails.
"""
import json, os, sys, statistics as st

DATA = os.path.join(os.path.dirname(__file__), "..", "data", "generated")
def load(name): return json.load(open(os.path.join(DATA, name), encoding="utf-8"))

kpi_values = load("kpi_values.json")
sales      = load("sales.json")
renewals   = load("renewals.json")
documents  = load("documents.json")

SOFTWARE_KEY = "Software (subscription)"
THEMES = ["software_bug", "shipping_delay", "product_quality", "competitor"]

# ----------------------------------------------------------------- stats port
def median(xs): return st.median(xs) if xs else 0.0
def mad(xs):
    if not xs: return 0.0
    m = median(xs); return median([abs(x - m) for x in xs])
def modified_z(xs, idx):
    x = xs[idx]; rest = [v for i, v in enumerate(xs) if i != idx]
    med = median(rest); scaled = 1.4826 * mad(rest)
    if scaled == 0: scaled = 1e-9
    return (0.6745 * (x - med)) / scaled
def tier_of(z):
    az = abs(z)
    return "significant" if az >= 3.5 else "notable" if az >= 2.0 else "normal"

def prev_period(p):
    y, m = map(int, p.split("-"))
    return f"{y-1}-12" if m == 1 else f"{y}-{m-1:02d}"

# --------------------------------------------------------------- anomaly port
def detect_at(kpi_key, region, period):
    series = sorted([r for r in kpi_values if r["kpi_key"] == kpi_key and r["region"] == region],
                    key=lambda r: r["period"])
    periods = [r["period"] for r in series]; vals = [r["value"] for r in series]
    mom_pct, mom_periods = [], []
    for i in range(1, len(vals)):
        prev = vals[i-1]
        pct = 0.0 if prev == 0 else (vals[i]-prev)/abs(prev)*100
        mom_pct.append(pct); mom_periods.append(periods[i])
    mi = mom_periods.index(period)
    z = modified_z(mom_pct, mi); pct = mom_pct[mi]
    direction = "flat" if abs(pct) < 0.5 else ("up" if pct > 0 else "down")
    return {"pct_change": round(pct,2), "zscore": round(z,2), "tier": tier_of(z),
            "direction": direction, "is_anomaly": tier_of(z) != "normal"}

# --------------------------------------------------------------- drivers port
def rows_for(region, period):
    return [r for r in sales if r["region"] == region and r["period"] == period]
def decompose_by(cur, prev, keyfn):
    keys = set([keyfn(r) for r in cur] + [keyfn(r) for r in prev])
    total = sum(r["revenue"] for r in cur) - sum(r["revenue"] for r in prev)
    out = []
    for k in keys:
        rc = sum(r["revenue"] for r in cur if keyfn(r) == k)
        rp = sum(r["revenue"] for r in prev if keyfn(r) == k)
        d = rc - rp
        out.append({"key": k, "delta": round(d), "pct_of_change": 0 if total == 0 else round(d/total*100,1)})
    return sorted(out, key=lambda c: -abs(c["delta"]))
def churn_breakdown(region, period):
    ch = [r for r in renewals if r["region"] == region and r["period"] == period and r["status"] == "churned"]
    by = {}
    for c in ch:
        reason = c.get("churn_reason") or "Unspecified"
        agg = by.setdefault(reason, {"count":0,"arr":0.0}); agg["count"]+=1; agg["arr"]+=c["arr"]
    by_reason = sorted([{"reason":k,"count":v["count"],"arr":round(v["arr"])} for k,v in by.items()],
                       key=lambda r: -r["arr"])
    return {"churned_count": len(ch), "churned_arr": round(sum(c["arr"] for c in ch)), "by_reason": by_reason}
def drivers(region, period):
    pp = prev_period(period); cur, prev = rows_for(region, period), rows_for(region, pp)
    return {
        "by_recurring": decompose_by(cur, prev, lambda r: SOFTWARE_KEY if r["recurring"] else "Physical goods"),
        "by_segment":   decompose_by(cur, prev, lambda r: r["segment"]),
        "churn": churn_breakdown(region, period),
    }

# ------------------------------------------------------------- retrieval port
def theme_spikes(region, period):
    base_periods = [prev_period(period)]
    for _ in range(11): base_periods.append(prev_period(base_periods[-1]))
    target = [d for d in documents if d["region"] == region and d["period"] == period]
    baseline = [d for d in documents if d["region"] == region and d["period"] in set(base_periods)]
    out = []
    for th in THEMES:
        count = sum(1 for d in target if th in d.get("themes", []))
        base_total = sum(1 for d in baseline if th in d.get("themes", []))
        base = base_total / len(base_periods)
        ratio = count / max(base, 0.5)
        out.append({"theme": th, "count": count, "baseline": round(base,2),
                    "ratio": round(ratio,1), "spiking": count >= 5 and ratio >= 3})
    return sorted(out, key=lambda s: -s["ratio"])

# ------------------------------------------------------------ confidence port
def score_confidence(anom, drv, spikes):
    reasons = []; score = 0
    score += 22 if anom["tier"]=="significant" else 14 if anom["tier"]=="notable" else 6
    topR = drv["by_recurring"][0] if drv["by_recurring"] else None
    topS = drv["by_segment"][0] if drv["by_segment"] else None
    top_share = min(100, max(abs(topR["pct_of_change"]) if topR else 0,
                             abs(topS["pct_of_change"]) if topS else 0))
    score += round((top_share/100)*26)
    software_dominant = (topR and topR["key"]==SOFTWARE_KEY and topR["delta"]<0) or drv["churn"]["churned_arr"]>0
    spiking = [s for s in spikes if s["spiking"]]
    aligned_theme = "software_bug" if software_dominant else (spiking[0]["theme"] if spiking else None)
    aligned = next((s for s in spikes if aligned_theme and s["theme"]==aligned_theme and s["spiking"]), None)
    if aligned: score += 24; reasons.append(f'corroborated by {aligned_theme} x{aligned["ratio"]}')
    elif spiking: score += 10
    churn = drv["churn"]; topReason = churn["by_reason"][0] if churn["by_reason"] else None
    reason_share = topReason["arr"]/churn["churned_arr"] if (topReason and churn["churned_arr"]>0) else 0
    if topReason and reason_share>=0.5 and topReason["reason"]!="Unspecified":
        is_bug = any(w in topReason["reason"].lower() for w in ["bug","402","crash","sync"])
        score += 12 if is_bug else 6
        if is_bug and aligned: score += 6
    no_cause = (not aligned) and not (topReason and reason_share>=0.5 and churn["churned_arr"]>0)
    ambiguity = anom["is_anomaly"] and no_cause
    if ambiguity: score = min(score, 38)
    score = max(0, min(100, round(score)))
    label = "High" if score>=70 else "Medium" if score>=45 else "Low"
    return {"score":score, "label":label, "ambiguity":ambiguity, "aligned_theme":aligned_theme,
            "software_dominant":software_dominant, "top_recurring":topR, "top_reason":topReason,
            "reason_share":round(reason_share,2)}

# --------------------------------------------------------------------- run it
def run_case(region, period):
    a = detect_at("revenue", region, period)
    d = drivers(region, period)
    s = theme_spikes(region, period)
    c = score_confidence(a, d, s)
    return a, d, s, c

failures = []
def check(cond, msg):
    print(("  PASS " if cond else "  FAIL ") + msg)
    if not cond: failures.append(msg)

print("="*72)
print("CASE A — EMEA / revenue / 2025-11  (expected: significant DOWN, CONFIRMED, High)")
print("="*72)
a,d,s,c = run_case("EMEA","2025-11")
print(f"  change: {a['pct_change']}%  z={a['zscore']}  tier={a['tier']}  dir={a['direction']}")
print(f"  top recurring driver: {c['top_recurring']}")
print(f"  churn: {d['churn']['churned_count']} accts, ${d['churn']['churned_arr']:,}  top_reason={d['churn']['by_reason'][0]['reason'] if d['churn']['by_reason'] else None}  share={c['reason_share']}")
print(f"  software_bug spike: {next(x for x in s if x['theme']=='software_bug')}")
print(f"  CONFIDENCE: {c['score']}/100 {c['label']}  ambiguity={c['ambiguity']}  aligned_theme={c['aligned_theme']}")
check(a["tier"]=="significant" and a["direction"]=="down", "EMEA move is significant & downward")
check(c["software_dominant"] and c["top_recurring"]["key"]==SOFTWARE_KEY and c["top_recurring"]["delta"]<0, "Software is the dominant negative driver")
check(d["churn"]["by_reason"] and "402" in d["churn"]["by_reason"][0]["reason"] and c["reason_share"]>=0.5, "Churn concentrated on Bug #402")
check(next(x for x in s if x['theme']=='software_bug')["spiking"], "software_bug theme is spiking")
check(c["label"]=="High" and not c["ambiguity"], "Confidence High and cause CONFIRMED")

print()
print("="*72)
print("CASE B — APAC / revenue / 2025-06  (expected: significant but AMBIGUOUS, Low)")
print("="*72)
a2,d2,s2,c2 = run_case("APAC","2025-06")
print(f"  change: {a2['pct_change']}%  z={a2['zscore']}  tier={a2['tier']}  dir={a2['direction']}")
print(f"  top recurring driver: {c2['top_recurring']}")
print(f"  churn: {d2['churn']['churned_count']} accts, ${d2['churn']['churned_arr']:,}")
print(f"  software_bug spike: {next(x for x in s2 if x['theme']=='software_bug')}")
print(f"  CONFIDENCE: {c2['score']}/100 {c2['label']}  ambiguity={c2['ambiguity']}  aligned_theme={c2['aligned_theme']}")
check(a2["is_anomaly"], "APAC move is a statistical anomaly")
check(not next(x for x in s2 if x['theme']=='software_bug')["spiking"], "software_bug NOT spiking in APAC/Jun")
check(d2["churn"]["churned_arr"]==0, "No churn cause in APAC/Jun")
check(c2["ambiguity"] and c2["label"]=="Low", "Confidence Low and flagged AMBIGUOUS")

print()
print("="*72)
if failures:
    print(f"RESULT: {len(failures)} FAILURE(S)"); [print("  - "+m) for m in failures]; sys.exit(1)
print("RESULT: ALL ENGINE CHECKS PASSED  ✅  (EMEA confirmed/High, APAC ambiguous/Low)")

"""
Verifies the generated seed data actually tells the intended story, using the same
robust statistics the Node anomaly engine will use (modified z-score on the
month-over-month % change series, so the growth trend doesn't create false signals).

Checks:
  A. EMEA revenue 2025-11 falls ~8% MoM and is a statistical outlier vs EMEA history.
  B. EMEA renewed ARR 2025-11 falls ~20% MoM (the root cause: enterprise churn).
  C. Bug #402 chatter (software_bug theme) spikes in EMEA 2025-11 vs its baseline.
  D. APAC 2025-06 revenue is an outlier (~ -8% to -12%) with NO doc/theme spike
     -> the ambiguous case the engine must flag as unconfirmed.

Exit code is non-zero if any hard assertion fails, so it doubles as a smoke test.
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(__file__).resolve().parents[1] / "data" / "generated"


def load(name):
    with open(OUT / f"{name}.json") as f:
        return pd.DataFrame(json.load(f))


def modified_z(series, target_period):
    """Modified z-score of one point vs the leave-one-out baseline (scaled MAD)."""
    s = series.dropna()
    x = float(s.loc[target_period])
    rest = s.drop(index=target_period)
    med = float(rest.median())
    mad = float((rest - med).abs().median())
    if mad == 0:
        mad = 1e-9
    return 0.6745 * (x - med) / (1.4826 * mad)


def tier(z):
    az = abs(z)
    if az >= 3.5:
        return "significant"
    if az >= 2.0:
        return "notable"
    return "normal"


def revenue_series(kv, region):
    r = kv[(kv.kpi_key == "revenue") & (kv.region == region)].sort_values("period")
    return r.set_index("period")["value"].astype(float)


def pct_change_series(level):
    return level.pct_change() * 100.0


def main():
    kv = load("kpi_values")
    docs = load("documents")
    renewals = load("renewals")

    ok = True

    print("=" * 72)
    print("A. EMEA REVENUE — demo month 2025-11")
    print("=" * 72)
    emea = revenue_series(kv, "EMEA")
    emea_pct = pct_change_series(emea)
    nov_pct = emea_pct.loc["2025-11"]
    z = modified_z(emea_pct, "2025-11")
    print(f"  EMEA revenue 2025-10 : ${emea.loc['2025-10']:,.0f}")
    print(f"  EMEA revenue 2025-11 : ${emea.loc['2025-11']:,.0f}")
    print(f"  MoM change           : {nov_pct:+.1f}%   (target ≈ -8%)")
    print(f"  modified z (of MoM%) : {z:+.2f}  -> {tier(z)}")
    a_ok = (-11.0 <= nov_pct <= -5.0) and tier(z) in ("notable", "significant")
    print(f"  PASS" if a_ok else "  FAIL"); ok &= a_ok

    print()
    print("=" * 72)
    print("B. EMEA RENEWED ARR — the root cause (enterprise churn)")
    print("=" * 72)
    arr = renewals[renewals.status == "renewed"]
    arr = arr[arr.region == "EMEA"].groupby("period")["arr"].sum().sort_index()
    arr_pct = arr.pct_change().mul(100)
    nov_arr_pct = arr_pct.loc["2025-11"]
    zc = modified_z(arr_pct, "2025-11")
    print(f"  EMEA renewed ARR 2025-10 : ${arr.loc['2025-10']:,.0f}")
    print(f"  EMEA renewed ARR 2025-11 : ${arr.loc['2025-11']:,.0f}")
    print(f"  MoM change               : {nov_arr_pct:+.1f}%   (target ≈ -20%)")
    print(f"  modified z (of MoM%)     : {zc:+.2f}  -> {tier(zc)}")
    b_ok = (-26.0 <= nov_arr_pct <= -14.0) and tier(zc) in ("notable", "significant")
    print(f"  PASS" if b_ok else "  FAIL"); ok &= b_ok

    print()
    print("=" * 72)
    print("C. BUG #402 CHATTER — corroborating unstructured signal in EMEA")
    print("=" * 72)
    docs["software_bug"] = docs["themes"].apply(lambda t: "software_bug" in t)
    emea_docs = docs[docs.region == "EMEA"]
    by_period = emea_docs.groupby("period")["software_bug"].sum()
    baseline = by_period.drop(index=["2025-11", "2025-10"], errors="ignore").mean()
    nov_bugs = int(by_period.get("2025-11", 0))
    oct_bugs = int(by_period.get("2025-10", 0))
    print(f"  EMEA software_bug docs, baseline avg : {baseline:.1f}/mo")
    print(f"  EMEA software_bug docs, 2025-10      : {oct_bugs}")
    print(f"  EMEA software_bug docs, 2025-11      : {nov_bugs}")
    print(f"  spike multiple vs baseline           : {nov_bugs / max(baseline, 1e-9):.1f}x")
    c_ok = nov_bugs >= max(8, 4 * baseline)
    print(f"  PASS" if c_ok else "  FAIL"); ok &= c_ok

    print()
    print("=" * 72)
    print("D. APAC 2025-06 — the AMBIGUOUS dip (outlier, but no signal)")
    print("=" * 72)
    apac = revenue_series(kv, "APAC")
    apac_pct = pct_change_series(apac)
    jun_pct = apac_pct.loc["2025-06"]
    zj = modified_z(apac_pct, "2025-06")
    apac_docs = docs[docs.region == "APAC"]
    apac_bug_by_period = apac_docs.groupby("period")["software_bug"].sum()
    apac_neg = apac_docs.assign(neg=apac_docs["negative"]).groupby("period")["neg"].sum()
    jun_bugs = int(apac_bug_by_period.get("2025-06", 0))
    jun_neg = int(apac_neg.get("2025-06", 0))
    neg_baseline = apac_neg.drop(index=["2025-06"], errors="ignore").mean()
    print(f"  APAC revenue 2025-05 : ${apac.loc['2025-05']:,.0f}")
    print(f"  APAC revenue 2025-06 : ${apac.loc['2025-06']:,.0f}")
    print(f"  MoM change           : {jun_pct:+.1f}%   (target ≈ -8% to -12%)")
    print(f"  modified z (of MoM%) : {zj:+.2f}  -> {tier(zj)}")
    print(f"  APAC Bug#402 docs Jun: {jun_bugs}  (should be ~0, background noise ok)")
    print(f"  APAC negative docs   : Jun={jun_neg} vs baseline {neg_baseline:.1f}/mo (should NOT spike)")
    d_ok = (tier(zj) in ("notable", "significant")) and jun_bugs <= 2 and jun_neg <= neg_baseline * 1.5
    print(f"  PASS" if d_ok else "  FAIL"); ok &= d_ok

    print()
    print("=" * 72)
    print("SANITY — other regions in the demo month should look NORMAL")
    print("=" * 72)
    for rc in ("NA", "APAC", "LATAM"):
        s = pct_change_series(revenue_series(kv, rc))
        zz = modified_z(s, "2025-11")
        print(f"  {rc:5s} revenue 2025-11 MoM {s.loc['2025-11']:+6.1f}%  z={zz:+.2f} -> {tier(zz)}")

    print()
    print("ALL CHECKS PASSED ✅" if ok else "SOME CHECKS FAILED ❌")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

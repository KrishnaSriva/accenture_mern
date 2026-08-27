import { useEffect, useMemo, useState } from "react";
import * as api from "./api";
import type { AnalysisPayload, AnomalyResult, Company, Kpi, Region } from "./types";
import Controls from "./components/Controls";
import KpiChart from "./components/KpiChart";
import StoryCard from "./components/StoryCard";
import ConfidenceBadge from "./components/ConfidenceBadge";
import ContributorBars from "./components/ContributorBars";
import HypothesisLedgerPanel from "./components/HypothesisLedgerPanel";
import EvidenceList from "./components/EvidenceList";

export default function App() {
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [periods, setPeriods] = useState<string[]>([]);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [company, setCompany] = useState("DEMO");
  const [sources, setSources] = useState<{ fmp: boolean; newsapi: boolean; gnews: boolean }>({
    fmp: false,
    newsapi: false,
    gnews: false,
  });
  const [connecting, setConnecting] = useState(false);
  const [connectMsg, setConnectMsg] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  const [kpi, setKpi] = useState("revenue");
  const [region, setRegion] = useState("EMEA");
  const [period, setPeriod] = useState("2025-11");
  const [remediationEffort, setRemediationEffort] = useState(0);

  const [data, setData] = useState<AnalysisPayload | null>(null);
  const [scanRows, setScanRows] = useState<AnomalyResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);

  // boot: list companies, then load the DEMO tenant and auto-run its headline story
  useEffect(() => {
    (async () => {
      try {
        const cs = await api.fetchCompanies();
        setCompanies(cs.companies);
        setSources(cs.sources);
        await loadCompany("DEMO");
      } catch (e) {
        setError(
          "Could not reach the API. Start the backend (npm run dev in /server) and make sure MongoDB is seeded."
        );
      } finally {
        setBooted(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // load a company's catalogs, pick sensible defaults, and run the first analysis
  async function loadCompany(code: string) {
    setLoading(true);
    setError(null);
    setScanRows(null);
    try {
      const [k, r] = await Promise.all([api.fetchKpis(code), api.fetchRegions(code)]);
      setKpis(k);
      setRegions(r);
      setCompany(code);

      const initKpi = k.some((x) => x.key === "revenue") ? "revenue" : k[0]?.key ?? "revenue";
      const initRegion =
        code === "DEMO" && r.some((x) => x.code === "EMEA") ? "EMEA" : r[0]?.code ?? "";
      setKpi(initKpi);
      setRegion(initRegion);

      // Periods are region-scoped, so they can only be fetched once the region is
      // known — a connected company's regions don't share one calendar.
      const p = initRegion ? await api.fetchPeriods(code, initRegion, initKpi) : [];
      setPeriods(p);
      const initPeriod =
        code === "DEMO" && p.includes("2025-11") ? "2025-11" : p[p.length - 1] ?? "";
      setPeriod(initPeriod);

      if (initRegion && initPeriod) {
        setData(await api.analyze(initKpi, initRegion, initPeriod, code));
      } else {
        setData(null);
        setError(`No analyzable series for ${code} yet — try connecting again or pick another company.`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function run(k: string, r: string, p: string) {
    setLoading(true);
    setError(null);
    try {
      setData(await api.analyze(k, r, p, company));
      setScanRows(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Changing the KPI or region also changes WHICH PERIODS EXIST — a connected
  // company stores quarterly income at region "Total" and annual geo segments per
  // region, so the two don't share a calendar. Re-point the period list at the new
  // axis, keep the current period only if it survives there (else take the latest),
  // then analyze. This is what stopped the chart looking frozen and killed the
  // "$0 → $NaN / held n/a" reads that came from analyzing a period with no row.
  async function changeAxis(k: string, r: string, preferred?: string) {
    const want = preferred ?? period;
    setKpi(k);
    setRegion(r);
    setLoading(true);
    setError(null);
    try {
      const list = await api.fetchPeriods(company, r, k);
      setPeriods(list);
      const next = list.includes(want) ? want : list[list.length - 1] ?? "";
      setPeriod(next);
      if (!next) {
        setData(null);
        setError(`No ${k} data for ${r} in this dataset — pick another region or KPI.`);
        return;
      }
      setData(await api.analyze(k, r, next, company));
      setScanRows(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function onKpiChange(v: string) {
    changeAxis(v, region);
  }
  function onRegionChange(v: string) {
    changeAxis(kpi, v);
  }
  function onPeriodChange(v: string) {
    setPeriod(v);
    run(kpi, region, v);
  }

  async function runScan() {
    setLoading(true);
    setError(null);
    try {
      setScanRows(await api.scan(kpi, period, company));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Demo shortcuts and scan-strip clicks change the region too, so route them
  // through changeAxis to keep the period list in sync with the new region.
  function onDemo(k: string, r: string, p: string) {
    changeAxis(k, r, p);
  }

  async function onConnect(ticker: string) {
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    setConnecting(true);
    setConnectMsg(null);
    setError(null);
    try {
      const summary = await api.connectCompany(t);
      const cs = await api.fetchCompanies();
      setCompanies(cs.companies);
      setSources(cs.sources);
      setConnectMsg({
        kind: "info",
        text:
          `Connected ${summary.name} — ${summary.counts.kpiValues} data points, ` +
          `${summary.counts.documents} documents from ${summary.sources.join(" + ") || "no source"}.` +
          (summary.note ? ` ${summary.note}` : ""),
      });
      await loadCompany(t);
    } catch (e) {
      setConnectMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setConnecting(false);
    }
  }

  const regionName = useMemo(
    () => regions.find((r) => r.code === region)?.name ?? region,
    [regions, region]
  );
  const companyName = useMemo(
    () => companies.find((c) => c.ticker === company)?.name ?? company,
    [companies, company]
  );

  return (
    <div className="min-h-screen">
      {/* header */}
      <header className="border-b border-hairline bg-black/20 backdrop-blur-xl sticky top-0 z-50">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand font-display text-base font-bold text-white shadow-[0_0_16px_rgba(129,140,248,0.4)] ring-1 ring-white/20">
              SR
            </div>
            <div>
              <div className="font-display text-xl font-bold leading-none tracking-tight text-white drop-shadow-sm">Signal Room</div>
              <div className="text-[11px] font-medium tracking-wide text-brand/80 uppercase mt-1">KPI Storytelling Engine</div>
            </div>
          </div>
          <div className="hidden text-right text-xs text-muted sm:block">
            <div className="font-mono text-sm font-bold text-white">{companyName}</div>
            <div className="mt-0.5">{company === "DEMO" ? "synthetic demo tenant" : "live data · connected company"}</div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6 space-y-6">
        <Controls
          kpis={kpis}
          regions={regions}
          periods={periods}
          companies={companies}
          company={company}
          sources={sources}
          connecting={connecting}
          connectMsg={connectMsg}
          kpi={kpi}
          region={region}
          period={period}
          loading={loading}
          onKpi={onKpiChange}
          onRegion={onRegionChange}
          onPeriod={onPeriodChange}
          onCompany={loadCompany}
          onConnect={onConnect}
          onAnalyze={() => run(kpi, region, period)}
          onScan={runScan}
          onDemo={onDemo}
        />

        <section className="space-y-6">
          {error && (
            <div className="panel border-down/30 bg-down/5 p-4 text-sm text-down">{error}</div>
          )}

          {!error && !data && !booted && (
            <div className="panel p-10 text-center text-sm text-muted">Loading Signal Room…</div>
          )}

          {/* scan strip */}
          {scanRows && (
            <div className="panel rise p-5">
              <div className="eyebrow">All regions · {kpi} · {period}</div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {scanRows.map((s) => {
                  const t = s.direction === "up" ? "text-up" : s.direction === "down" ? "text-down" : "text-white";
                  return (
                    <button
                      key={s.region}
                      onClick={() => onDemo(kpi, s.region, period)}
                      className={`rounded-lg border p-3 text-left transition hover:border-brand/40 ${
                        s.is_anomaly ? "border-down/30 bg-down/5" : "border-hairline"
                      }`}
                    >
                      <div className="font-display text-sm font-bold text-white">{s.region}</div>
                      <div className={`font-mono text-lg font-bold ${t}`}>
                        {s.pct_change != null ? `${s.pct_change > 0 ? "+" : ""}${s.pct_change}%` : "—"}
                      </div>
                      <div className="font-mono text-[11px] text-muted">
                        z={s.zscore} · {s.tier}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {data && (
            <>
              {/* chart */}
              <div className="panel rise p-5 relative overflow-hidden group">
                {/* Glow effect behind chart */}
                <div className="absolute -inset-20 bg-brand/5 blur-3xl rounded-full opacity-0 group-hover:opacity-100 transition duration-1000"></div>
                <div className="relative z-10 flex items-center justify-between">
                  <div className="eyebrow">
                    {companyName} · {data.meta.name} · {regionName}
                  </div>
                  <div className="font-mono text-xs text-brand">flagged: {data.change.period}</div>
                </div>
                <div className="relative z-10 mt-2">
                  <KpiChart
                    series={data.change.series}
                    anomalyPeriod={data.change.period}
                    direction={data.change.direction}
                    unit={data.meta.unit}
                    effort={remediationEffort}
                  />
                </div>
              </div>

              {/* story + confidence/drivers */}
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                <div className="lg:col-span-2">
                  <StoryCard 
                    data={data} 
                    effort={remediationEffort} 
                    onEffortChange={setRemediationEffort} 
                  />
                </div>
                <div className="space-y-6">
                  <ConfidenceBadge confidence={data.confidence} />
                  <ContributorBars drivers={data.drivers} aggregate={data.aggregate} />
                </div>
              </div>

              {/* competing explanations — the correlation→decision step */}
              {data.ledger && <HypothesisLedgerPanel ledger={data.ledger} />}

              {/* evidence */}
              <EvidenceList evidence={data.evidence} />
            </>
          )}
        </section>

        <footer className="mt-10 border-t border-hairline pt-4 text-center text-xs text-muted">
          Numbers, drivers, and evidence are computed deterministically. The language model only narrates from those
          facts — it never invents figures or causes.
        </footer>
      </main>
    </div>
  );
}

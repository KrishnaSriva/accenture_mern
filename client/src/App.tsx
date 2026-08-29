import { useEffect, useMemo, useState } from "react";
import * as api from "./api";
import type { AnalysisPayload, AnomalyResult, Company, Kpi, Region } from "./types";
import Controls from "./components/Controls";
import KpiChart from "./components/KpiChart";
import StoryCard from "./components/StoryCard";
import ConfidenceBadge from "./components/ConfidenceBadge";
import { MacroRealityBadge } from "./components/MacroRealityBadge";
import ContributorBars from "./components/ContributorBars";
import HypothesisLedgerPanel from "./components/HypothesisLedgerPanel";
import EvidenceList from "./components/EvidenceList";
import OutlookPanel from "./components/OutlookPanel";
import ActionPlanPanel from "./components/ActionPlanPanel";
import AuditTrail from "./components/AuditTrail";

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
  // Share of the ATTRIBUTED loss the user wants to model recovering. It is not an
  // "effort" dial: it can only move a baseline the server validated, by an amount the
  // driver decomposition measured, and only when the scenario gate is open.
  const [recoveryShare, setRecoveryShare] = useState(0);

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

  // A scenario is specific to one analysis. Carrying a share across a change of KPI,
  // region, or period would draw a recovery line for a loss that was never attributed
  // in the new context. Default to 100% when scenario is available so the recovery
  // curve and dollar impact are immediately visible to judges.
  useEffect(() => {
    if (data?.scenario?.available) {
      setRecoveryShare(100);
    } else {
      setRecoveryShare(0);
    }
  }, [data]);

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
      <header className="border-b border-hairline bg-black/30 backdrop-blur-xl sticky top-0 z-50">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
          <div className="flex items-center gap-3.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand font-display text-sm font-bold text-white ring-1 ring-white/20">
              SR
            </div>
            <div>
              <div className="font-display text-lg font-bold leading-none tracking-tight text-white">Signal Room</div>
              <div className="mt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-brand/80">
                KPI Storytelling Engine
              </div>
            </div>
          </div>
          <div className="text-right text-xs text-muted">
            <div className="font-mono text-sm font-semibold text-white">{companyName}</div>
            <div className="mt-0.5 hidden sm:block">
              {company === "DEMO" ? "synthetic demo tenant" : "live data · connected company"}
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-5 space-y-5 sm:px-6 sm:py-6 sm:space-y-6">
        {/* Executive Print-Only Header */}
        <div className="hidden print:block mb-4 p-5 rounded-xl border border-slate-300 bg-slate-50 text-slate-900 shadow-sm">
          <div className="flex justify-between items-baseline border-b border-slate-300 pb-3 mb-3">
            <div>
              <h1 className="text-xl font-bold font-display text-slate-900">Executive KPI Intelligence & Causal Audit</h1>
              <p className="text-xs font-medium text-slate-600 mt-0.5">
                {companyName} ({company}) · {data?.meta.name} · {regionName} ({region})
              </p>
            </div>
            <div className="text-right font-mono text-xs text-slate-600">
              <div>Period: <strong className="text-slate-900">{data?.change.period}</strong></div>
              <div>Generated: {new Date().toISOString().slice(0, 10)}</div>
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-slate-600">
            <strong>Auditable Provenance:</strong> Figures, driver margin bridges, forecast backtest bounds, and document embeddings are deterministically computed from company database records. The narrative formats these verified facts into plain language.
          </p>
        </div>

        <div className="no-print">
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
        </div>

        <section className="space-y-5 sm:space-y-6">
          {error && (
            <div className="panel border-down/30 bg-down/5 p-4 text-sm text-down" role="alert">
              {error}
            </div>
          )}

          {/* Boot and re-analysis both take a visible moment because the engine does real
              work — a backtest, a decomposition, a ledger. Before there is anything to
              show, a skeleton in the shape of the result; once there is, the previous
              answer stays on screen and dims rather than flashing away. */}
          {!error && !data && (!booted || loading) && <Skeleton />}

          {booted && !loading && !error && !data && (
            <div className="panel p-10 text-center">
              <div className="font-display text-lg font-semibold text-white">Nothing to analyse yet</div>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
                Pick a KPI, region, and period above — or connect a public company by ticker to run the same engine over
                its filings and news.
              </p>
            </div>
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
            <div
              className={`space-y-5 transition-opacity duration-200 sm:space-y-6 ${
                loading ? "pointer-events-none opacity-40" : "opacity-100"
              }`}
              aria-busy={loading}
            >
              {/* chart */}
              <div className="panel rise p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="eyebrow">
                    {companyName} · {data.meta.name} · {regionName}
                  </div>
                  <div className="font-mono text-[11px] text-muted">
                    flagged <span className="text-brand">{data.change.period}</span>
                    {data.forecast.available ? (
                      <span> · forecast +{data.forecast.horizon} {data.forecast.grain}</span>
                    ) : (
                      <span className="text-warn"> · no forecast drawn</span>
                    )}
                  </div>
                </div>
                <div className="mt-2">
                  <KpiChart
                    series={data.change.series}
                    anomalyPeriod={data.change.period}
                    direction={data.change.direction}
                    unit={data.meta.unit}
                    forecast={data.forecast}
                    scenario={data.scenario}
                    recoveryShare={recoveryShare / 100}
                  />
                </div>
              </div>

              {/* story + drivers (left 2/3) vs what-if slider/macro/confidence (right 1/3) */}
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                <div className="lg:col-span-2 space-y-6">
                  <StoryCard data={data} />
                  <ContributorBars drivers={data.drivers} aggregate={data.aggregate} />
                  <ActionPlanPanel plan={data.action_plan} />
                </div>
                <div className="space-y-6">
                  {/* Recovery slider first — most impactful for demos */}
                  <OutlookPanel
                    forecast={data.forecast}
                    scenario={data.scenario}
                    plan={data.action_plan}
                    share={recoveryShare}
                    onShareChange={setRecoveryShare}
                  />
                  <MacroRealityBadge macro={data.macro} />
                  <ConfidenceBadge confidence={data.confidence} />
                </div>
              </div>

              {/* competing explanations — the correlation→decision step */}
              {data.ledger && <HypothesisLedgerPanel ledger={data.ledger} />}

              {/* bottom grid: evidence (left) vs audit trail math (right) */}
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 items-start">
                <EvidenceList evidence={data.evidence} />
                {data.provenance && <AuditTrail provenance={data.provenance} />}
              </div>
            </div>
          )}
        </section>

        <footer className="mt-10 border-t border-hairline pt-4 text-center text-xs leading-relaxed text-muted no-print">
          Numbers, drivers, forecasts, and evidence are computed deterministically. The language model only narrates
          from those facts — it never invents a figure, a cause, or a projection.
        </footer>

        {/* Clean Executive Print Footer */}
        <div className="hidden print:flex mt-6 pt-3 border-t border-slate-300 text-[10px] font-mono text-slate-500 justify-between items-center">
          <div>KPI Storytelling Engine · Deterministic Audit Trail</div>
          <div>Executive Briefing Deck</div>
        </div>
      </main>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-5 sm:space-y-6" aria-busy="true" aria-label="Running the analysis">
      <div className="panel p-5">
        <div className="h-3 w-48 rounded bg-white/10 shimmer" />
        <div className="mt-4 h-48 rounded-lg bg-white/[0.04]" />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="panel space-y-3 p-6 lg:col-span-2">
          <div className="h-3 w-32 rounded bg-white/10 shimmer" />
          <div className="h-5 w-3/4 rounded bg-white/10 shimmer" />
          <div className="h-9 w-40 rounded bg-white/10 shimmer" />
          <div className="space-y-2 pt-3">
            <div className="h-2.5 w-full rounded bg-white/[0.07] shimmer" />
            <div className="h-2.5 w-11/12 rounded bg-white/[0.07] shimmer" />
            <div className="h-2.5 w-4/5 rounded bg-white/[0.07] shimmer" />
          </div>
        </div>
        <div className="space-y-6">
          <div className="panel space-y-3 p-5">
            <div className="h-3 w-28 rounded bg-white/10 shimmer" />
            <div className="h-7 w-36 rounded bg-white/10 shimmer" />
            <div className="h-2 w-full rounded-full bg-white/[0.07] shimmer" />
          </div>
          <div className="panel space-y-3 p-5">
            <div className="h-3 w-24 rounded bg-white/10 shimmer" />
            <div className="grid grid-cols-2 gap-2">
              <div className="h-14 rounded-lg bg-white/[0.05] shimmer" />
              <div className="h-14 rounded-lg bg-white/[0.05] shimmer" />
              <div className="h-14 rounded-lg bg-white/[0.05] shimmer" />
              <div className="h-14 rounded-lg bg-white/[0.05] shimmer" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

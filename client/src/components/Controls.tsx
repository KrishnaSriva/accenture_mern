import { useState } from "react";
import type { Company, Kpi, Region } from "../types";

interface Props {
  kpis: Kpi[];
  regions: Region[];
  periods: string[];
  companies: Company[];
  company: string;
  sources: { fmp: boolean; newsapi: boolean; gnews: boolean };
  connecting: boolean;
  connectMsg: { kind: "info" | "error"; text: string } | null;
  kpi: string;
  region: string;
  period: string;
  loading: boolean;
  onKpi: (v: string) => void;
  onRegion: (v: string) => void;
  onPeriod: (v: string) => void;
  onCompany: (code: string) => void;
  onConnect: (ticker: string) => void;
  onAnalyze: () => void;
  onScan: () => void;
  onDemo: (kpi: string, region: string, period: string) => void;
}

const DEMOS = [
  { label: "EMEA · Nov 2025", sub: "Confirmed — Bug #402", kpi: "revenue", region: "EMEA", period: "2025-11" },
  { label: "APAC · Jun 2025", sub: "Ambiguous — no signal", kpi: "revenue", region: "APAC", period: "2025-06" },
];

export default function Controls(p: Props) {
  const [ticker, setTicker] = useState("");
  const canConnect = p.sources.fmp || p.sources.newsapi || p.sources.gnews;
  const isDemo = p.company === "DEMO";

  function submitConnect() {
    const t = ticker.trim();
    if (t && !p.connecting) p.onConnect(t);
  }

  return (
    <div className="panel p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {/* company / data source */}
      <div>
        <div className="eyebrow">Company</div>
        <div className="mt-3 flex gap-2">
          <label className="flex-1">
            <select className="select" value={p.company} onChange={(e) => p.onCompany(e.target.value)}>
              {p.companies.map((c) => (
                <option key={c.ticker} value={c.ticker}>
                  {c.ticker === "DEMO" ? "DEMO (Synthetic)" : `${c.ticker} — ${c.name}`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3">
          <div className="flex gap-2">
            <input
              className="select flex-1 uppercase"
              placeholder="Ticker, e.g. AMZN"
              value={ticker}
              disabled={!canConnect || p.connecting}
              onChange={(e) => setTicker(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitConnect()}
            />
            <button
              className="btn-primary px-3"
              onClick={submitConnect}
              disabled={!canConnect || p.connecting || !ticker.trim()}
              title={canConnect ? "Pull real data" : "Add an API key to enable"}
            >
              {p.connecting ? "…" : "Connect"}
            </button>
          </div>
          {p.connectMsg && (
            <p
              className={`mt-2 rounded-md border p-2 text-[11px] leading-snug ${
                p.connectMsg.kind === "error"
                  ? "border-down/30 bg-down/5 text-down"
                  : "border-up/30 bg-up/5 text-up"
              }`}
            >
              {p.connectMsg.text}
            </p>
          )}
        </div>
      </div>

      {/* KPI move */}
      <div className="lg:col-span-2">
        <div className="eyebrow">Analyze a KPI move</div>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted">Metric</span>
            <select className="select" value={p.kpi} onChange={(e) => p.onKpi(e.target.value)}>
              {p.kpis.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted">Region</span>
            <select className="select" value={p.region} onChange={(e) => p.onRegion(e.target.value)}>
              {p.regions.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.name === r.code ? r.code : `${r.name} (${r.code})`}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted">Period</span>
            <select className="select" value={p.period} onChange={(e) => p.onPeriod(e.target.value)}>
              {p.periods.map((pd) => (
                <option key={pd} value={pd}>
                  {pd}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-3 flex gap-2">
          <button className="btn-primary flex-1" onClick={p.onAnalyze} disabled={p.loading}>
            {p.loading ? "Analyzing…" : "Explain this change"}
          </button>
          <button
            className="rounded-lg border border-hairline px-3 py-2 text-sm font-semibold text-white/70 transition hover:border-brand/40 hover:text-brand disabled:opacity-50"
            onClick={p.onScan}
            disabled={p.loading}
            title="Rank all regions for this metric & period"
          >
            Scan
          </button>
        </div>
      </div>
      
      {/* demo scenarios */}
      {isDemo && (
        <div className="md:col-span-2 lg:col-span-3 border-t border-hairline pt-4">
          <div className="eyebrow">Demo scenarios</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {DEMOS.map((d) => (
              <button
                key={d.label}
                onClick={() => p.onDemo(d.kpi, d.region, d.period)}
                className="rounded-lg border border-hairline p-3 text-left transition hover:border-brand/40 hover:bg-brand-soft/10"
              >
                <div className="font-mono text-xs font-bold text-white">{d.label}</div>
                <div className="text-[11px] text-muted">{d.sub}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

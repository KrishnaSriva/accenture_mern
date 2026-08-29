import React from "react";
import type { MacroAnalysis } from "../types";

interface Props {
  macro?: MacroAnalysis;
}

export const MacroRealityBadge: React.FC<Props> = ({ macro }) => {
  if (!macro || !macro.available) return null;

  const {
    classification,
    classification_label,
    internal_impact_pct,
    macro_impact_pct,
    summary,
    series_id,
    series_title,
    macro_pct_change,
    source,
  } = macro;

  const isInternal = classification === "internal_incident";
  const isHeadwind = classification === "macro_headwind";
  const isTailwind = classification === "market_tailwind";

  const badgeColor = isInternal
    ? "bg-rose-500/10 text-rose-400 border-rose-500/30"
    : isHeadwind
    ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
    : isTailwind
    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
    : "bg-sky-500/10 text-sky-400 border-sky-500/30";

  const badgeDot = isInternal
    ? "bg-rose-500 animate-pulse"
    : isHeadwind
    ? "bg-amber-500"
    : isTailwind
    ? "bg-emerald-500"
    : "bg-sky-500";

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg backdrop-blur-md transition-all hover:border-slate-700/80">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              Macro Reality Badge
              <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
                FRED: {series_id}
              </span>
            </h3>
            <p className="text-xs text-slate-400">Attribution: Internal Operational Factors vs. Market Macro Trends</p>
          </div>
        </div>

        {/* Badge Status Tag */}
        <div className={`px-3 py-1.5 rounded-full border text-xs font-medium flex items-center gap-2 ${badgeColor}`}>
          <span className={`w-2 h-2 rounded-full ${badgeDot}`} />
          {classification_label}
        </div>
      </div>

      {/* Comparative Split Bar */}
      <div className="space-y-2 mb-4">
        <div className="flex justify-between text-xs font-mono font-medium">
          <span className="text-rose-400">Internal Operational Impact ({internal_impact_pct}%)</span>
          <span className="text-sky-400">Macro Market Trend ({macro_impact_pct}%)</span>
        </div>
        <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden flex p-0.5 border border-slate-700/50">
          <div
            className="h-full bg-gradient-to-r from-rose-500 to-amber-500 rounded-l-full transition-all duration-700"
            style={{ width: `${internal_impact_pct}%` }}
            title={`Internal Impact: ${internal_impact_pct}%`}
          />
          <div
            className="h-full bg-gradient-to-r from-sky-500 to-indigo-500 rounded-r-full transition-all duration-700"
            style={{ width: `${macro_impact_pct}%` }}
            title={`Macro Impact: ${macro_impact_pct}%`}
          />
        </div>
      </div>

      {/* Plain Language Summary */}
      <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80 text-xs text-slate-300 leading-relaxed mb-3">
        <span className="font-semibold text-slate-200">Reconciliation: </span>
        {summary}
      </div>

      {/* Data Source & Citation Bar */}
      <div className="flex flex-wrap items-center justify-between text-[11px] font-mono text-slate-400 pt-2 border-t border-slate-800/60">
        <span className="truncate max-w-[280px]" title={series_title}>
          Indicator: <span className="text-slate-300">{series_title}</span>
        </span>
        {macro_pct_change != null && (
          <span className={macro_pct_change >= 0 ? "text-emerald-400 font-semibold" : "text-amber-400 font-semibold"}>
            Shift: {macro_pct_change >= 0 ? `+${macro_pct_change}%` : `${macro_pct_change}%`}
          </span>
        )}
        <span className="text-slate-500">
          Source: {source === "fred_api" ? "Live St. Louis Fed API" : "FRED Macro Baseline"}
        </span>
      </div>
    </div>
  );
};

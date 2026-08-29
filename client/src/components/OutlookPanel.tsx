/**
 * What the engine is willing to say about the future — and what it refuses to say.
 *
 * This panel exists because a forecast line is the easiest thing in a dashboard to
 * fake and the hardest to justify. Everything here is the server's own audit of its
 * forecast: which candidate method won a rolling-origin backtest, how wrong that
 * method actually was out of sample, whether it beat a naive carry-forward, and how
 * often its published interval really contained the truth. When the series cannot
 * support any of that, the panel prints the refusal instead of a chart.
 *
 * The recovery slider lives here rather than next to the narrative because it is a
 * statement about the forecast, not about the story: it can only move a line the
 * server already validated, by an amount the driver decomposition already measured.
 */
import type { ActionPlan, Forecast, RecoveryScenario } from "../types";

interface Props {
  forecast: Forecast;
  scenario: RecoveryScenario;
  plan: ActionPlan;
  share: number;
  onShareChange: (v: number) => void;
}

function money(v: number | null, unit: string): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const p = unit === "USD" ? "$" : "";
  const a = Math.abs(v);
  const s = v < 0 ? "-" : "";
  if (a >= 1e12) return `${s}${p}${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${s}${p}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}${p}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}${p}${Math.round(a / 1e3)}k`;
  return `${s}${p}${Math.round(a)}`;
}

const GATE_LABEL: Record<RecoveryScenario["gate"], string> = {
  open: "Scenario available",
  no_forecast: "No scenario — nothing to project from",
  favourable_move: "No scenario — the move was favourable",
  cause_unconfirmed: "Scenario locked — cause not confirmed",
  no_quantified_driver: "No scenario — no driver could be sized",
};

export default function OutlookPanel({ forecast, scenario, plan, share, onShareChange }: Props) {
  const bt = forecast.backtest;

  return (
    <div className="panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="eyebrow">Outlook</div>
        <div className="font-mono text-[11px] text-muted">
          {forecast.available
            ? `${forecast.horizon} ${forecast.grain}${forecast.horizon > 1 ? "s" : ""} ahead · ${forecast.interval_pct}% interval`
            : "withheld"}
        </div>
      </div>

      {!forecast.available ? (
        <div className="mt-3 rounded-lg border border-warn/25 bg-warn-soft/10 p-4">
          <div className="text-sm font-semibold text-warn">This series does not support a forecast</div>
          <p className="mt-1.5 text-xs leading-relaxed text-white/75">{forecast.refusal}</p>
          <p className="mt-2 border-t border-white/10 pt-2 text-[11px] text-muted">
            A line would still have rendered here. It would have been a guess with a chart around it, so the engine
            draws nothing instead.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Method" value={forecast.method_label ?? "—"} hint="won the backtest" />
            <Stat
              label="Out-of-sample error"
              value={bt?.median_ape != null ? `${bt.median_ape}%` : "—"}
              hint={`median APE over ${bt?.origins ?? 0} origins`}
            />
            <Stat
              label="Skill vs naive"
              value={bt?.skill != null ? `${bt.skill > 0 ? "+" : ""}${bt.skill}%` : "—"}
              hint={bt?.beats_naive ? "better than carry-forward" : "no better than carry-forward"}
              tone={bt?.beats_naive ? "up" : "warn"}
            />
            <Stat
              label="Interval coverage"
              value={bt?.coverage != null ? `${bt.coverage}%` : "not measurable"}
              hint={
                bt?.coverage != null
                  ? `target ${bt.target_coverage}% · ${bt.coverage_checks} checks`
                  : "too few folds to check"
              }
            />
          </div>

          {bt && bt.by_horizon.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[420px] text-left text-xs">
                <thead>
                  <tr className="border-b border-hairline text-[10px] uppercase tracking-wider text-muted">
                    <th className="py-1.5 pr-3 font-semibold">Horizon</th>
                    <th className="py-1.5 pr-3 font-semibold">Folds</th>
                    <th className="py-1.5 pr-3 font-semibold">Median APE</th>
                    <th className="py-1.5 pr-3 font-semibold">Naive</th>
                    <th className="py-1.5 font-semibold">Band ±</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-white/85">
                  {bt.by_horizon.map((h) => (
                    <tr key={h.horizon} className="border-b border-white/5 last:border-0">
                      <td className="py-1.5 pr-3">+{h.horizon}</td>
                      <td className="py-1.5 pr-3 text-muted">{h.folds}</td>
                      <td className="py-1.5 pr-3">{h.median_ape}%</td>
                      <td className="py-1.5 pr-3 text-muted">{h.naive_median_ape}%</td>
                      <td className="py-1.5">
                        {h.half_width_pct}%
                        {h.widened_from_h1 && <span className="ml-1 text-[10px] text-warn">widened</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {bt && bt.candidates.length > 0 && (
            <div className="mt-4">
              <div className="eyebrow">Candidates considered</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {bt.candidates.map((c) => {
                  const won = c.method === forecast.method;
                  return (
                    <span
                      key={c.method}
                      title={c.note ?? (c.eligible ? `${c.folds} folds` : "not eligible on this series")}
                      className={`rounded-md border px-2 py-1 font-mono text-[10px] ${
                        won
                          ? "border-brand/40 bg-brand/15 text-brand"
                          : c.eligible
                          ? "border-hairline text-white/70"
                          : "border-white/5 text-white/35 line-through decoration-white/25"
                      }`}
                    >
                      {c.label}
                      {c.median_ape != null && ` · ${c.median_ape}%`}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {forecast.notes.length > 0 && (
        <ul className="mt-4 space-y-1 border-t border-hairline pt-3">
          {forecast.notes.map((n, i) => (
            <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-muted">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-white/25" />
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}

      {/* recovery scenario — a slider only when the engine can defend one */}
      <div className={`mt-4 rounded-xl border p-4 ${scenario.available ? "border-emerald-500/30 bg-emerald-950/20" : "border-hairline bg-black/20"}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className={`eyebrow ${scenario.available ? "text-emerald-400" : "text-warn"}`}>
            {scenario.available ? "🎛️ What-If Recovery Scenario" : GATE_LABEL[scenario.gate]}
          </div>
          {scenario.available && <div className="font-mono text-xs font-bold text-emerald-400">{share}% applied</div>}
        </div>

        {scenario.available ? (
          <>
            {/* Big Impact Number */}
            <div className="mt-3 rounded-lg bg-black/30 p-3 text-center border border-emerald-500/20">
              <div className="text-[10px] uppercase tracking-widest text-emerald-500/70 font-mono">Modelled ARR Recovery</div>
              <div className="mt-1 font-mono text-3xl font-bold text-emerald-400 tabular-nums">
                +{money(scenario.recoverable * (share / 100), scenario.unit)}
              </div>
              <div className="mt-0.5 text-[10px] text-emerald-600 font-mono">
                of {money(scenario.recoverable, scenario.unit)} addressable · {scenario.share_of_move_pct}% of total move
              </div>
            </div>

            <p className="mt-2.5 text-xs leading-relaxed text-white/70">
              Fixing <span className="font-semibold text-white">{scenario.attributed_to}</span>{" "}
              ({scenario.mechanism}) could recover up to{" "}
              <span className="font-mono font-semibold text-emerald-400">{money(scenario.recoverable, scenario.unit)}</span>.
              Drag the slider to model partial recovery timelines.
            </p>

            {/* Quick Presets */}
            <div className="mt-3 flex items-center justify-between gap-1.5">
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted">If we fix</span>
              <div className="flex gap-1">
                {[25, 50, 75, 100].map((preset) => (
                  <button
                    key={preset}
                    onClick={() => onShareChange(preset)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-mono font-bold transition border ${
                      share === preset
                        ? "bg-emerald-600/30 text-emerald-300 border-emerald-500/50 shadow-[0_0_8px_rgba(52,211,153,0.2)]"
                        : "bg-slate-800/60 text-slate-400 border-slate-700/60 hover:text-emerald-300 hover:border-emerald-700/50"
                    }`}
                  >
                    {preset}%
                  </button>
                ))}
              </div>
            </div>

            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={share}
              onChange={(e) => onShareChange(Number(e.target.value))}
              aria-label="Share of the attributed loss recovered"
              className="mt-2 w-full cursor-pointer accent-emerald-500"
            />

            {/* Context numbers */}
            <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] font-mono text-muted">
              <div>Baseline endpoint <span className="text-white/75">{money(scenario.baseline_endpoint, scenario.unit)}</span></div>
              <div>Full recovery <span className="text-white/75">{money(scenario.full_recovery_endpoint, scenario.unit)}</span></div>
              <div className="col-span-2 text-[9px] leading-relaxed">{scenario.ramp_label} · {scenario.basis}</div>
            </div>
          </>
        ) : (
          <>
            <p className="mt-1.5 text-xs leading-relaxed text-white/75">{scenario.reason}</p>
            {scenario.gate === "cause_unconfirmed" && plan.actions[0] && (
              <p className="mt-2 border-t border-white/10 pt-2 text-[11px] text-warn/90">
                Unlock it by running the deciding test first: {plan.actions[0].action}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "up" | "warn";
}) {
  const c = tone === "up" ? "text-up" : tone === "warn" ? "text-warn" : "text-white";
  return (
    <div className="rounded-lg border border-hairline bg-black/20 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-1 font-mono text-sm font-bold leading-tight ${c}`}>{value}</div>
      <div className="mt-0.5 text-[10px] leading-snug text-muted">{hint}</div>
    </div>
  );
}

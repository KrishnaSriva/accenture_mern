/**
 * The KPI line — history, and a forecast only when the server validated one.
 *
 * Nothing on the forward side of this chart is invented in the browser. The dashed
 * path is the baseline the server backtested, the shaded ribbon is its empirical
 * 80% interval, and the scenario line (if any) is baseline + a share of a loss the
 * engine actually attributed. When the server refuses to forecast, the chart simply
 * stops at the last observed period.
 */
import { useMemo, useState, type MouseEvent } from "react";
import type { Forecast, Point, RecoveryScenario } from "../types";

interface Props {
  series: Point[];
  anomalyPeriod: string;
  direction: "up" | "down" | "flat";
  unit: string;
  forecast?: Forecast | null;
  scenario?: RecoveryScenario | null;
  recoveryShare?: number;
}

const W = 760;
const H = 264;
const PAD = { t: 24, r: 18, b: 34, l: 62 };

function compact(x: number, unit: string): string {
  if (!Number.isFinite(x)) return "—";
  const p = unit === "USD" ? "$" : "";
  const a = Math.abs(x);
  const s = x < 0 ? "-" : "";
  if (a >= 1e12) return `${s}${p}${(a / 1e12).toFixed(1)}T`;
  if (a >= 1e9) return `${s}${p}${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${s}${p}${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}${p}${Math.round(a / 1e3)}k`;
  return `${s}${p}${Math.round(a)}`;
}

function path(pts: Array<{ cx: number; cy: number }>): string {
  if (!pts.length) return "";
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join(" ");
}

export default function KpiChart({
  series,
  anomalyPeriod,
  direction,
  unit,
  forecast,
  scenario,
  recoveryShare = 0,
}: Props) {
  const [hover, setHover] = useState<number | null>(null);

  const g = useMemo(() => {
    const fc = forecast?.available ? forecast.points : [];
    const share = scenario?.available ? Math.max(0, Math.min(1, recoveryShare)) : 0;
    const scenValues =
      share > 0 && scenario?.available
        ? fc.map(
            (p, i) => p.value + share * scenario.recoverable * (scenario.ramp[i] ?? (i + 1) / fc.length)
          )
        : [];

    const values = [
      ...series.map((p) => p.value),
      ...fc.flatMap((p) => [p.lo, p.hi, p.value]),
      ...scenValues,
    ].filter((v) => Number.isFinite(v));

    const rawMin = values.length ? Math.min(...values) : 0;
    const rawMax = values.length ? Math.max(...values) : 1;
    const pad = (rawMax - rawMin || Math.abs(rawMax) || 1) * 0.08;
    const min = rawMin - pad;
    const max = rawMax + pad;
    const span = max - min || 1;

    const innerW = W - PAD.l - PAD.r;
    const innerH = H - PAD.t - PAD.b;
    const n = series.length + fc.length;
    const x = (i: number) => PAD.l + (n <= 1 ? 0 : (i / (n - 1)) * innerW);
    const y = (v: number) => PAD.t + innerH - ((v - min) / span) * innerH;

    const hist = series.map((p, i) => ({ ...p, cx: x(i), cy: y(p.value) }));
    const anchor = hist[hist.length - 1];
    const fcPts = fc.map((p, i) => ({
      ...p,
      cx: x(series.length + i),
      cy: y(p.value),
      cyLo: y(p.lo),
      cyHi: y(p.hi),
    }));
    const scen = scenValues.map((v, i) => ({ cx: fcPts[i].cx, cy: y(v), value: v, period: fc[i].period }));

    const band = anchor
      ? [{ cx: anchor.cx, cyHi: anchor.cy, cyLo: anchor.cy }, ...fcPts]
      : fcPts;
    const bandPath =
      band.length > 1
        ? `${band.map((p, i) => `${i === 0 ? "M" : "L"}${p.cx.toFixed(1)},${p.cyHi.toFixed(1)}`).join(" ")} ` +
          `${[...band].reverse().map((p) => `L${p.cx.toFixed(1)},${p.cyLo.toFixed(1)}`).join(" ")} Z`
        : "";

    return {
      hist,
      fcPts,
      scen,
      anchor,
      bandPath,
      min,
      max,
      aIdx: series.findIndex((p) => p.period === anomalyPeriod),
      share,
    };
  }, [series, anomalyPeriod, unit, forecast, scenario, recoveryShare]);

  const accent = direction === "up" ? "#34d399" : direction === "down" ? "#fb7185" : "#818cf8";
  const slots = [
    ...g.hist.map((p) => ({ cx: p.cx, cy: p.cy, period: p.period, value: p.value, kind: "history" as const })),
    ...g.fcPts.map((p) => ({ cx: p.cx, cy: p.cy, period: p.period, value: p.value, kind: "forecast" as const, lo: p.lo, hi: p.hi })),
  ];
  const a = g.aIdx >= 0 ? g.hist[g.aIdx] : null;
  const hovered = hover != null ? slots[hover] : null;
  const gridY = [0, 0.25, 0.5, 0.75, 1];

  const labelPts: Array<{ cx: number; period: string }> = [];
  const pushLabel = (p?: { cx: number; period: string }) => {
    if (p && !labelPts.some((q) => q.period === p.period)) labelPts.push({ cx: p.cx, period: p.period });
  };
  pushLabel(g.hist[0]);
  pushLabel(a ?? undefined);
  pushLabel(g.hist[g.hist.length - 1]);
  pushLabel(g.fcPts[g.fcPts.length - 1]);
  labelPts.sort((p, q) => p.cx - q.cx);

  function onMove(e: MouseEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    let bestD = Infinity;
    slots.forEach((s, i) => {
      const d = Math.abs(s.cx - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full select-none"
        role="img"
        aria-label="KPI history with the analysed period highlighted and a validated forecast where one is available"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="kpiFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity="0.22" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </linearGradient>
        </defs>

        {gridY.map((t, i) => {
          const yy = PAD.t + t * (H - PAD.t - PAD.b);
          const v = g.max - t * (g.max - g.min);
          return (
            <g key={i}>
              <line x1={PAD.l} y1={yy} x2={W - PAD.r} y2={yy} stroke="rgba(148,163,184,0.12)" strokeWidth="1" />
              <text
                x={PAD.l - 10}
                y={yy + 3}
                textAnchor="end"
                fill="#64748b"
                style={{ fontSize: 9.5, fontVariantNumeric: "tabular-nums" }}
              >
                {compact(v, unit)}
              </text>
            </g>
          );
        })}

        {g.anchor && (
          <path
            d={`${path(g.hist)} L${g.anchor.cx.toFixed(1)},${H - PAD.b} L${g.hist[0].cx.toFixed(1)},${H - PAD.b} Z`}
            fill="url(#kpiFill)"
          />
        )}

        {g.bandPath && <path d={g.bandPath} fill="#94a3b8" fillOpacity="0.14" />}

        {g.fcPts.length > 0 && g.anchor && (
          <path
            d={path([{ cx: g.anchor.cx, cy: g.anchor.cy }, ...g.fcPts])}
            fill="none"
            stroke="#94a3b8"
            strokeWidth="2"
            strokeDasharray="5 5"
            strokeLinecap="round"
          />
        )}

        {g.scen.length > 0 && g.anchor && (
          <path
            d={path([{ cx: g.anchor.cx, cy: g.anchor.cy }, ...g.scen])}
            fill="none"
            stroke="#38bdf8"
            strokeWidth="2"
            strokeDasharray="2 4"
            strokeLinecap="round"
          />
        )}

        <path d={path(g.hist)} fill="none" stroke={accent} strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" />

        {g.anchor && g.fcPts.length > 0 && (
          <>
            <line
              x1={g.anchor.cx}
              y1={PAD.t}
              x2={g.anchor.cx}
              y2={H - PAD.b}
              stroke="rgba(148,163,184,0.35)"
              strokeWidth="1"
            />
            <text x={g.anchor.cx + 6} y={PAD.t + 10} fill="#64748b" style={{ fontSize: 9 }}>
              forecast →
            </text>
          </>
        )}

        {g.hist.map((p, i) => (
          <circle key={`h${i}`} cx={p.cx} cy={p.cy} r={i === g.aIdx ? 0 : 1.5} fill={accent} opacity={0.45} />
        ))}
        {g.fcPts.map((p, i) => (
          <circle key={`f${i}`} cx={p.cx} cy={p.cy} r={2} fill="#0b1120" stroke="#94a3b8" strokeWidth="1.5" />
        ))}

        {a && (
          <g>
            <line x1={a.cx} y1={PAD.t} x2={a.cx} y2={H - PAD.b} stroke={accent} strokeWidth="1" strokeDasharray="3 3" opacity="0.45" />
            <circle cx={a.cx} cy={a.cy} r="4.5" fill={accent} stroke="#0b1120" strokeWidth="2" />
            <text
              x={a.cx}
              y={PAD.t - 8}
              textAnchor="middle"
              fill={accent}
              style={{ fontSize: 10, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}
            >
              {anomalyPeriod}
            </text>
          </g>
        )}

        {labelPts.map((p, i) => (
          <text
            key={`x${p.period}`}
            x={p.cx}
            y={H - 10}
            textAnchor={i === 0 ? "start" : i === labelPts.length - 1 ? "end" : "middle"}
            fill="#64748b"
            style={{ fontSize: 9.5, fontVariantNumeric: "tabular-nums" }}
          >
            {p.period}
          </text>
        ))}

        {hovered && (
          <g>
            <line x1={hovered.cx} y1={PAD.t} x2={hovered.cx} y2={H - PAD.b} stroke="rgba(226,232,240,0.25)" strokeWidth="1" />
            <circle cx={hovered.cx} cy={hovered.cy} r="3.5" fill={hovered.kind === "forecast" ? "#94a3b8" : accent} />
            <g transform={`translate(${Math.min(Math.max(hovered.cx - 62, PAD.l), W - PAD.r - 124)}, ${PAD.t + 4})`}>
              <rect width="124" height={hovered.kind === "forecast" ? 44 : 30} rx="5" fill="#0b1120" fillOpacity="0.92" stroke="rgba(148,163,184,0.25)" />
              <text x="8" y="13" fill="#94a3b8" style={{ fontSize: 9 }}>
                {hovered.period}
                {hovered.kind === "forecast" ? " · forecast" : ""}
              </text>
              <text x="8" y="25" fill="#e2e8f0" style={{ fontSize: 11, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                {compact(hovered.value, unit)}
              </text>
              {hovered.kind === "forecast" && "lo" in hovered && (
                <text x="8" y="38" fill="#94a3b8" style={{ fontSize: 9, fontVariantNumeric: "tabular-nums" }}>
                  {`${forecast?.interval_pct ?? 80}% band ${compact(hovered.lo, unit)} – ${compact(hovered.hi, unit)}`}
                </text>
              )}
            </g>
          </g>
        )}
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-slate-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded" style={{ background: accent }} />
          observed
        </span>
        {forecast?.available ? (
          <>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded border-t border-dashed border-slate-400" />
              baseline · {forecast.method_label}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-4 rounded-sm bg-slate-400/20" />
              {forecast.interval_pct}% band from its own backtest errors
            </span>
          </>
        ) : (
          <span>no forecast drawn — {forecast?.refusal ?? "not validated on this series"}</span>
        )}
        {g.scen.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded" style={{ background: "#38bdf8" }} />
            recovery scenario ({Math.round(g.share * 100)}% of attributed loss)
          </span>
        )}
      </div>
    </div>
  );
}

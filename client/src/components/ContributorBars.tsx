import type { AggregateDrivers, DriverResult } from "../types";

function money(x: number): string {
  if (!Number.isFinite(x)) return "—"; // never render "$NaN"
  const sign = x < 0 ? "−" : "";
  const a = Math.abs(Math.round(x));
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}k`;
  return `${sign}$${a}`;
}
function pctStr(x: number | null): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${x > 0 ? "+" : ""}${x}%`;
}
function ppStr(x: number | null): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${x > 0 ? "+" : ""}${x}pp`;
}

function Bars({ items }: { items: Array<{ key: string; delta: number; pct_of_change: number }> }) {
  const max = Math.max(...items.map((i) => Math.abs(i.delta)), 1);
  return (
    <div className="space-y-2.5">
      {items.map((it) => {
        const neg = it.delta < 0;
        const w = (Math.abs(it.delta) / max) * 100;
        return (
          <div key={it.key} className="grid grid-cols-[130px_1fr_auto] items-center gap-3">
            <div className="truncate text-xs font-medium text-ink/80" title={it.key}>
              {it.key}
            </div>
            <div className="relative h-5 rounded bg-white/[0.06]">
              <div
                className={`meter-fill absolute top-0 h-5 rounded ${neg ? "bg-down/80" : "bg-up/80"}`}
                style={{ width: `${w}%` }}
              />
            </div>
            <div className={`font-mono text-xs tabular-nums ${neg ? "text-down" : "text-up"}`}>
              {money(it.delta)}
              <span className="ml-1 text-[10px] text-muted">{it.pct_of_change}%</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The reported-totals view. A connected company has no order-level rows, but the
 * gross-profit identity and the segment mix are real decompositions — this panel
 * shows them instead of the note that used to say a breakdown "isn't available".
 */
function AggregateView({ aggregate }: { aggregate: AggregateDrivers }) {
  const m = aggregate.margin;
  const s = aggregate.seasonal;
  const grainLabel =
    aggregate.grain === "quarter"
      ? "quarter on quarter"
      : aggregate.grain === "annual"
      ? "year on year"
      : aggregate.grain === "month"
      ? "month on month"
      : "period on period";

  const bridgeItems =
    m.available && m.revenue_effect != null && m.margin_effect != null
      ? [
          { label: "Revenue", val: m.revenue_effect },
          { label: "Margin", val: m.margin_effect },
          { label: "Interaction", val: m.interaction ?? 0 },
        ]
      : [];
  const bridgeMax = Math.max(...bridgeItems.map((i) => Math.abs(i.val)), 1);

  return (
    <div className="panel p-5">
      <div className="flex items-baseline justify-between">
        <div className="eyebrow">Where the change came from</div>
        {aggregate.prev_period && (
          <span className="text-[10px] uppercase tracking-wide text-muted">
            {aggregate.prev_period} → {aggregate.period}
          </span>
        )}
      </div>

      {/* P&L line movements — the raw material for everything below */}
      {aggregate.kpi_deltas.length > 0 && (
        <>
          <div className="mt-3 text-xs font-semibold text-muted">
            Reported P&amp;L, {grainLabel}
          </div>
          <div className="mt-2 space-y-1.5">
            {aggregate.kpi_deltas.map((d) => (
              <div key={d.kpi_key} className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-ink/80">{d.label}</span>
                <span className="shrink-0 font-mono tabular-nums text-muted">
                  {money(d.prev)} → {money(d.cur)}
                  <span className={`ml-2 font-bold ${d.delta < 0 ? "text-down" : "text-up"}`}>
                    {pctStr(d.pct_change)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* the gross-profit bridge: sold more, or kept more of it? */}
      {bridgeItems.length > 0 && (
        <div className="mt-5 border-t border-hairline pt-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted">Gross-profit bridge</span>
            {m.dominant && (
              <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">
                {m.dominant} driven
              </span>
            )}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {bridgeItems.map((it) => (
              <div key={it.label} className="rounded-lg border border-hairline p-2.5">
                <div className="text-[10px] uppercase tracking-wide text-muted">{it.label}</div>
                <div className={`font-mono text-sm font-bold ${it.val < 0 ? "text-down" : "text-up"}`}>
                  {money(it.val)}
                </div>
                <div className="mt-1.5 h-1 rounded-full bg-white/[0.06]">
                  <div
                    className={`h-1 rounded-full ${it.val < 0 ? "bg-down" : "bg-up"}`}
                    style={{ width: `${(Math.abs(it.val) / bridgeMax) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2.5 text-[11px] leading-relaxed text-muted">
            Gross margin {m.gross_margin_prev}% → {m.gross_margin_cur}% ({ppStr(m.margin_delta_pp)})
            {m.flow_through != null && <> · {m.flow_through}% of the revenue change reached gross profit</>}
          </p>
        </div>
      )}

      {/* operating leverage — did the top-line move reach the bottom line? */}
      {m.available && m.operating_leverage && (
        <div className="mt-4 rounded-lg border border-hairline p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted">Operating leverage</span>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                m.operating_leverage === "negative"
                  ? "bg-down/10 text-down"
                  : m.operating_leverage === "positive"
                  ? "bg-up/10 text-up"
                  : "bg-white/[0.06] text-muted"
              }`}
            >
              {m.operating_leverage}
            </span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            Revenue {pctStr(m.revenue_growth)} vs. operating expenses {pctStr(m.opex_growth)} · opex ratio{" "}
            {m.opex_ratio_prev}% → {m.opex_ratio_cur}% ({ppStr(m.opex_ratio_delta_pp)})
          </p>
        </div>
      )}

      {/* regional mix: contribution AND share shift */}
      {aggregate.mix.length > 0 && (
        <div className="mt-5 border-t border-hairline pt-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted">
              By reported segment ({aggregate.mix_basis})
            </span>
            {aggregate.concentration != null && (
              <span className="font-mono text-[10px] text-muted">
                top {Math.round(aggregate.concentration)}%
              </span>
            )}
          </div>
          <div className="mt-2">
            <Bars items={aggregate.mix} />
          </div>
          <ul className="mt-2.5 space-y-1">
            {aggregate.mix.slice(0, 3).map((c) => (
              <li key={c.key} className="flex items-baseline justify-between gap-3 text-[11px] text-muted">
                <span>{c.key} share of mix</span>
                <span className="shrink-0 font-mono tabular-nums">
                  {c.share_prev}% → {c.share_cur}%{" "}
                  <span className={c.share_delta_pp < 0 ? "text-down" : "text-up"}>
                    {ppStr(c.share_delta_pp)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* is this meaningful, or does this period always do this? */}
      {s.available && (
        <div className="mt-5 border-t border-hairline pt-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted">Seasonal check · {s.phase}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                s.matches_pattern ? "bg-white/[0.06] text-muted" : "bg-brand-soft text-brand"
              }`}
            >
              {s.matches_pattern ? "normal for the season" : "breaks the pattern"}
            </span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            {s.phase} typically moves {pctStr(s.typical)} ({s.prior_changes.map((c) => pctStr(c)).join(", ")}
            {" from "}
            {s.prior_changes.length} prior year{s.prior_changes.length === 1 ? "" : "s"}); this period moved{" "}
            {pctStr(s.current)}, a {pctStr(s.deviation)} deviation.
          </p>
        </div>
      )}

      {/* what this instrument cannot see — stated, not hidden */}
      {aggregate.notes.length > 0 && (
        <p className="mt-4 border-t border-hairline pt-3 text-[11px] leading-relaxed text-muted">
          {aggregate.notes[0]}
        </p>
      )}
    </div>
  );
}

export default function ContributorBars({
  drivers,
  aggregate,
}: {
  drivers: DriverResult;
  aggregate?: AggregateDrivers;
}) {
  const b = drivers.price_volume_software;
  const churn = drivers.churn;

  const hasStructured =
    drivers.by_recurring.length > 0 ||
    drivers.by_segment.length > 0 ||
    churn.churned_count > 0 ||
    drivers.price_volume.units_cur > 0 ||
    drivers.price_volume.units_prev > 0;

  // No order-level rows (a connected company). Fall back to the reported totals —
  // a weaker instrument than order data, but a real one.
  if (!hasStructured) {
    if (aggregate?.available) return <AggregateView aggregate={aggregate} />;
    return (
      <div className="panel p-5">
        <div className="eyebrow">Where the change came from</div>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          {aggregate?.notes?.[0] ??
            "This KPI is reported on its own for this segment, with no companion line or segment split to decompose the move against."}{" "}
          See the evidence panel below for qualitative context.
        </p>
      </div>
    );
  }

  const bridgeItems = [
    { label: "Volume", val: b.volume_effect },
    { label: "Price", val: b.price_effect },
    { label: "Mix", val: b.interaction },
  ];
  const bridgeMax = Math.max(...bridgeItems.map((i) => Math.abs(i.val)), 1);

  return (
    <div className="panel p-5">
      <div className="eyebrow">Where the change came from</div>
      <div className="mt-3 text-xs font-semibold text-muted">Software vs. physical</div>
      <div className="mt-2">
        <Bars items={drivers.by_recurring} />
      </div>

      <div className="mt-5 text-xs font-semibold text-muted">By segment</div>
      <div className="mt-2">
        <Bars items={drivers.by_segment.slice(0, 4)} />
      </div>

      {/* price / volume bridge for the subscription line — was it lost customers or changed price? */}
      <div className="mt-5 border-t border-hairline pt-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-muted">Subscription price–volume bridge</span>
          <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">
            {b.dominant} driven
          </span>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {bridgeItems.map((it) => (
            <div key={it.label} className="rounded-lg border border-hairline p-2.5">
              <div className="text-[10px] uppercase tracking-wide text-muted">{it.label}</div>
              <div className={`font-mono text-sm font-bold ${it.val < 0 ? "text-down" : "text-up"}`}>{money(it.val)}</div>
              <div className="mt-1.5 h-1 rounded-full bg-white/[0.06]">
                <div
                  className={`h-1 rounded-full ${it.val < 0 ? "bg-down" : "bg-up"}`}
                  style={{ width: `${(Math.abs(it.val) / bridgeMax) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* churn — the CRM side of the story */}
      {churn.churned_count > 0 && (
        <div className="mt-5 border-t border-hairline pt-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted">Renewal churn this period</span>
            <span className="font-mono text-xs font-bold text-down">
              {churn.churned_count} accts · {money(-churn.churned_arr)} ARR
            </span>
          </div>
          <ul className="mt-2 space-y-1">
            {churn.by_reason.slice(0, 3).map((r) => (
              <li key={r.reason} className="flex items-start justify-between gap-3 text-xs">
                <span className="text-ink/80">{r.reason}</span>
                <span className="shrink-0 font-mono text-muted">{money(-r.arr)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

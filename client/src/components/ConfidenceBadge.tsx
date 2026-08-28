import type { Confidence } from "../types";

/**
 * The signature element: a verdict stamp, a score meter, and — the part that matters —
 * the arithmetic behind the score.
 *
 * The product's thesis is honest causal reasoning, so the confidence in the CAUSE is
 * the hero, not the size of the move. Each scoring channel is shown with the points it
 * earned against the points it could have earned, so a high score can be inspected
 * rather than trusted. When a ceiling was applied, the uncapped subtotal is printed
 * beside the capped score with the reason — that is the difference between evidence
 * that locates a change and evidence that explains it.
 */
function verdict(c: Confidence): { label: string; tone: "up" | "brand" | "warn"; blurb: string } {
  if (c.ambiguity.flag)
    return { label: "UNCONFIRMED", tone: "warn", blurb: "Real move, cause not supported by evidence" };
  if (c.label === "High") return { label: "CONFIRMED", tone: "up", blurb: "Structured + unstructured signals agree" };
  if (c.label === "Medium") return { label: "PROBABLE", tone: "brand", blurb: "Partial corroboration" };
  return { label: "WEAK", tone: "warn", blurb: "Limited supporting signal" };
}

const TONE = {
  up: { text: "text-up", bg: "bg-up", tint: "bg-up/[0.06]", ring: "ring-up/20" },
  brand: { text: "text-brand", bg: "bg-brand", tint: "bg-brand/[0.06]", ring: "ring-brand/20" },
  warn: { text: "text-warn", bg: "bg-warn", tint: "bg-warn/[0.06]", ring: "ring-warn/20" },
} as const;

export default function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const v = verdict(confidence);
  const t = TONE[v.tone];
  const capped = confidence.ceiling.applied;

  return (
    <div className={`panel p-5 ${t.tint} ring-1 ${t.ring}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="eyebrow">Cause confidence</div>
          <div className={`mt-1 font-display text-2xl font-bold tracking-tight ${t.text}`}>{v.label}</div>
          <div className="mt-0.5 text-xs text-muted">{v.blurb}</div>
        </div>
        <div className="text-right">
          <div className={`font-mono text-4xl font-bold leading-none ${t.text}`}>{confidence.score}</div>
          <div className="text-[11px] text-muted">/ 100 · {confidence.label}</div>
        </div>
      </div>

      {/* meter with threshold ticks at 45 (Medium) and 70 (High) */}
      <div className="relative mt-4 h-2 rounded-full bg-white/10">
        <div className={`meter-fill h-2 rounded-full ${t.bg}`} style={{ width: `${confidence.score}%` }} />
        {capped && confidence.ceiling.value != null && (
          <span
            className="absolute -top-1.5 h-5 w-0.5 bg-warn"
            style={{ left: `${confidence.ceiling.value}%` }}
            title={`Ceiling ${confidence.ceiling.value}: ${confidence.ceiling.reason}`}
          />
        )}
        <span className="absolute -top-1 h-4 w-px bg-white/20" style={{ left: "45%" }} />
        <span className="absolute -top-1 h-4 w-px bg-white/20" style={{ left: "70%" }} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] uppercase tracking-wider text-muted">
        <span>weak</span>
        <span>probable</span>
        <span>confirmed</span>
      </div>

      {capped && (
        <div className="mt-3 rounded-lg border border-warn/25 bg-warn-soft/10 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-warn">Ceiling applied</span>
            <span className="font-mono text-[11px] text-warn">
              {confidence.subtotal} → {confidence.ceiling.value}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-white/80">{confidence.ceiling.reason}</p>
        </div>
      )}

      {confidence.components.length > 0 && (
        <div className="mt-4 border-t border-white/10 pt-3">
          <div className="eyebrow">How the score was earned</div>
          <ul className="mt-2 space-y-2">
            {confidence.components.map((c) => (
              <li key={c.id}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] font-medium text-white/85">{c.label}</span>
                  <span className="font-mono text-[10px] text-muted">
                    {c.points}/{c.max}
                  </span>
                </div>
                <div className="mt-1 h-1 rounded-full bg-white/10">
                  <div
                    className={`h-1 rounded-full ${c.points > 0 ? t.bg : "bg-transparent"}`}
                    style={{ width: `${c.max > 0 ? Math.min(100, (c.points / c.max) * 100) : 0}%` }}
                  />
                </div>
                <p className="mt-0.5 text-[10px] leading-snug text-muted">{c.detail}</p>
              </li>
            ))}
          </ul>
          <div className="mt-2.5 flex items-baseline justify-between border-t border-white/10 pt-2 text-[11px]">
            <span className="text-muted">Subtotal before ceiling</span>
            <span className="font-mono font-semibold text-white/85">{confidence.subtotal}</span>
          </div>
        </div>
      )}

      {confidence.reasons.length > 0 && (
        <ul className="mt-4 space-y-1.5 border-t border-white/10 pt-3">
          {confidence.reasons.map((r, i) => (
            <li key={i} className="flex gap-2 text-xs text-white/80">
              <span className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${t.bg}`} />
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

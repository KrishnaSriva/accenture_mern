import type { Confidence } from "../types";

/**
 * The signature element: a verdict stamp + score meter.
 * The product's thesis is honest causal reasoning, so the confidence in the CAUSE
 * — and whether it's confirmed or merely a statistical outlier — is the hero.
 */
function verdict(c: Confidence): { label: string; tone: "up" | "brand" | "warn"; blurb: string } {
  if (c.ambiguity.flag)
    return { label: "UNCONFIRMED", tone: "warn", blurb: "Real move, cause not supported by evidence" };
  if (c.label === "High") return { label: "CONFIRMED", tone: "up", blurb: "Structured + unstructured signals agree" };
  if (c.label === "Medium") return { label: "PROBABLE", tone: "brand", blurb: "Partial corroboration" };
  return { label: "WEAK", tone: "warn", blurb: "Limited supporting signal" };
}

const TONE = {
  up: { text: "text-up", bg: "bg-up", soft: "bg-emerald-50", ring: "ring-up/20" },
  brand: { text: "text-brand", bg: "bg-brand", soft: "bg-brand-soft", ring: "ring-brand/20" },
  warn: { text: "text-warn", bg: "bg-warn", soft: "bg-warn-soft", ring: "ring-warn/20" },
} as const;

export default function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const v = verdict(confidence);
  const t = TONE[v.tone];
  return (
    <div className={`panel p-5 ${t.soft} ring-1 ${t.ring}`}>
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
      <div className="relative mt-4 h-2 rounded-full bg-black/5">
        <div className={`meter-fill h-2 rounded-full ${t.bg}`} style={{ width: `${confidence.score}%` }} />
        <span className="absolute -top-1 h-4 w-px bg-black/15" style={{ left: "45%" }} />
        <span className="absolute -top-1 h-4 w-px bg-black/15" style={{ left: "70%" }} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] uppercase tracking-wider text-muted">
        <span>weak</span>
        <span>probable</span>
        <span>confirmed</span>
      </div>

      {confidence.reasons.length > 0 && (
        <ul className="mt-4 space-y-1.5 border-t border-black/5 pt-3">
          {confidence.reasons.map((r, i) => (
            <li key={i} className="flex gap-2 text-xs text-ink/80">
              <span className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${t.bg}`} />
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import type { AnalysisPayload } from "../types";

function fmt(v: number | null, unit: string): string {
  if (v == null || !Number.isFinite(v)) return "—"; // never render "$NaN"
  if (unit === "USD") {
    const a = Math.abs(v);
    if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
    if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (a >= 1e3) return `$${Math.round(v / 1e3)}k`;
    return `$${Math.round(v)}`;
  }
  if (unit === "%") return `${v}%`;
  return Math.round(v).toLocaleString();
}

const TIER_LABEL: Record<string, string> = {
  significant: "Significant outlier",
  notable: "Notable move",
  normal: "Within normal range",
};

export default function StoryCard({ data }: { data: AnalysisPayload }) {
  const { story, change, meta } = data;
  const w = story.what_changed;
  const dir = change.direction;
  const tone = dir === "up" ? "text-up" : dir === "down" ? "text-down" : "text-ink";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "—";

  return (
    <div className="panel rise p-6">
      {/* headline + the move */}
      <div className="eyebrow">
        {meta.name} · {w.region} · {w.period}
      </div>
      <h2 className="mt-1 font-display text-xl font-bold leading-snug tracking-tight text-ink">{story.headline}</h2>

      <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <div className="text-[11px] text-muted">Change</div>
          <div className={`font-mono text-3xl font-bold leading-none ${tone}`}>
            {arrow} {change.pct_change != null ? `${change.pct_change > 0 ? "+" : ""}${change.pct_change}%` : "—"}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-muted">
            {w.prev_period} → {w.period}
          </div>
          <div className="font-mono text-lg text-ink/80">
            {fmt(w.prev_value, meta.unit)} <span className="text-muted">→</span> {fmt(w.value, meta.unit)}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-muted">Signal strength</div>
          <div className="font-mono text-lg text-ink/80">
            z = {change.zscore} <span className="text-xs text-muted">· {TIER_LABEL[change.tier]}</span>
          </div>
        </div>
      </div>

      {/* narrative */}
      <div className="mt-5 whitespace-pre-line border-t border-hairline pt-5 text-sm leading-relaxed text-white/90">
        {story.narrative.split(/\[([^\]]+)\]/g).map((part, i) => {
          if (i % 2 === 1) {
            // Narrative citations carry a document_id. This previously read
            // `sample_documents` / `d.id` — neither exists on RetrievalResult, so
            // every chip silently fell back to "Source Document".
            const doc = data.evidence.top_documents?.find((d) => d.document_id === part);
            const titleText = doc ? `"${doc.text}"` : "Source Document";
            return (
              <span
                key={i}
                className="inline-flex cursor-help items-center justify-center rounded bg-brand/15 border border-brand/30 px-1.5 py-0.5 mx-0.5 font-mono text-[10px] font-bold text-brand transition hover:bg-brand/30"
                title={titleText}
              >
                DOC
              </span>
            );
          }
          return <span key={i}>{part}</span>;
        })}
      </div>

      {/* primary cause */}
      <div className="mt-5 rounded-lg bg-brand-soft/20 border border-brand/20 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="eyebrow text-brand">Primary cause</div>
          {/* The ruling sits next to the claim so the claim can't be read without it. */}
          {story.decision && (
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                story.decision.verdict === "confirmed"
                  ? "bg-up/20 text-up"
                  : story.decision.verdict === "leading"
                  ? "bg-brand/25 text-brand"
                  : story.decision.verdict === "ambiguous"
                  ? "bg-warn/20 text-warn"
                  : "bg-white/10 text-white/60"
              }`}
              title={story.decision.rationale}
            >
              {story.decision.verdict}
              {story.decision.leading_score != null && ` · ${story.decision.leading_score}/100`}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm font-medium text-white">{story.why.primary_cause}</p>
        <p className="mt-1.5 text-xs text-white/70">{story.why.mechanism}</p>
        {story.decision?.verdict === "ambiguous" && story.decision.runner_up && (
          <p className="mt-2 border-t border-white/10 pt-2 text-xs text-warn/90">
            Competing explanation not ruled out: {story.decision.runner_up} — within{" "}
            {story.decision.margin_of_victory} points. See the deciding test below.
          </p>
        )}
      </div>

      {/* uncertainty — honesty about the limits */}
      <div className="mt-5 rounded-lg border border-warn/25 bg-warn-soft/10 p-4">
        <div className="eyebrow text-warn">What could change this read</div>
        <ul className="mt-2 space-y-1.5">
          {story.uncertainty.map((u, i) => (
            <li key={i} className="flex gap-2 text-xs text-white/80">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-warn" />
              <span>{u}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

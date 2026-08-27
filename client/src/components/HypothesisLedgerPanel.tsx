import { useState } from "react";
import type { Hypothesis, HypothesisLedger } from "../types";

/**
 * The hypothesis ledger — the engine's answer to "how does this move from
 * correlation to something a business leader can act on, and what does it do when
 * the data is genuinely ambiguous?"
 *
 * Every candidate cause is listed with a decomposed score and, critically, the
 * observation that would DISCONFIRM it. When the top two are too close to separate,
 * the panel leads with the test that would separate them rather than a false answer.
 */

const VERDICT: Record<
  HypothesisLedger["verdict"],
  { label: string; blurb: string; cls: string }
> = {
  confirmed: {
    label: "Cause confirmed",
    blurb: "Independent channels agree and the leader is clear of the alternatives.",
    cls: "bg-up/15 text-up ring-up/30",
  },
  leading: {
    label: "Leading explanation",
    blurb: "One cause is ahead, but not far enough to treat as settled.",
    cls: "bg-brand-soft text-brand ring-brand/30",
  },
  ambiguous: {
    label: "Genuinely ambiguous",
    blurb: "Two causes fit the data almost equally well. The engine is not picking one.",
    cls: "bg-warn-soft text-warn ring-warn/30",
  },
  insufficient: {
    label: "Not explainable yet",
    blurb: "No candidate cause clears the evidence bar. The move is observed, not understood.",
    cls: "bg-white/[0.06] text-muted ring-white/10",
  },
};

const CHANNEL_LABEL: Record<string, string> = {
  structured: "Internal records",
  unstructured: "Qualitative signal",
  direction: "Direction fits",
  arithmetic: "Accounting identity",
};

function ChannelChips({ h, weights }: { h: Hypothesis; weights: HypothesisLedger["weights"] }) {
  const entries = (Object.keys(weights) as Array<keyof typeof weights>)
    .map((k) => ({
      key: k,
      label: CHANNEL_LABEL[k] ?? k,
      earned: Math.round(weights[k] * (h.channels[k] ?? 0)),
      max: weights[k],
    }))
    .filter((e) => e.earned > 0);

  if (entries.length === 0) {
    return <p className="text-[11px] text-muted">No channel earned any credit.</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map((e) => (
        <span
          key={e.key}
          className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] text-ink/70"
          title={`${e.label}: ${e.earned} of a possible ${e.max} points`}
        >
          {e.label} {e.earned}/{e.max}
        </span>
      ))}
    </div>
  );
}

function Row({
  h,
  rank,
  weights,
  open,
  onToggle,
}: {
  h: Hypothesis;
  rank: number;
  weights: HypothesisLedger["weights"];
  open: boolean;
  onToggle: () => void;
}) {
  const tone =
    h.status === "leading" ? "bg-brand" : h.status === "possible" ? "bg-brand/50" : "bg-white/20";
  return (
    <div className="border-t border-hairline py-3 first:border-t-0">
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3">
          <span className="w-4 shrink-0 font-mono text-[10px] text-muted">{rank}</span>
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink" title={h.label}>
            {h.label}
          </span>
          <span className="shrink-0 font-mono text-xs font-bold tabular-nums text-ink">
            {h.score}
            <span className="text-[10px] font-normal text-muted">/100</span>
          </span>
          <span className="shrink-0 text-[10px] text-muted">{open ? "−" : "+"}</span>
        </div>
        <div className="mt-1.5 ml-7 h-1.5 rounded-full bg-white/[0.06]">
          <div className={`meter-fill h-1.5 rounded-full ${tone}`} style={{ width: `${h.score}%` }} />
        </div>
      </button>

      {open && (
        <div className="ml-7 mt-2.5 space-y-2.5">
          <p className="text-[11px] leading-relaxed text-ink/80">{h.statement}</p>
          <ChannelChips h={h} weights={weights} />

          {h.support.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-up">For</div>
              <ul className="mt-1 space-y-1">
                {h.support.map((s, i) => (
                  <li key={i} className="text-[11px] leading-relaxed text-muted">
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {h.against.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-down">Against</div>
              <ul className="mt-1 space-y-1">
                {h.against.map((s, i) => (
                  <li key={i} className="text-[11px] leading-relaxed text-muted">
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-lg border border-dashed border-hairline p-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">
              What would disprove this
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink/80">{h.test}</p>
          </div>

          {h.evidence_ids.length > 0 && (
            <p className="font-mono text-[10px] text-muted">
              Evidence: {h.evidence_ids.join(", ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function HypothesisLedgerPanel({ ledger }: { ledger: HypothesisLedger }) {
  const v = VERDICT[ledger.verdict] ?? VERDICT.insufficient;
  // Open the leader by default — and both contenders when the verdict is a tie,
  // because the whole point of "ambiguous" is that you must see the alternative.
  const [open, setOpen] = useState<Set<string>>(
    () =>
      new Set(
        [ledger.leading?.id, ledger.verdict === "ambiguous" ? ledger.runner_up?.id : undefined].filter(
          Boolean
        ) as string[]
      )
  );
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="panel p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="eyebrow">Competing explanations</div>
          <p className="mt-1 text-[11px] text-muted">
            {ledger.hypotheses.length} cause{ledger.hypotheses.length === 1 ? "" : "s"} scored on four
            independent evidence channels
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ring-1 ${v.cls}`}
        >
          {v.label}
        </span>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-ink/80">{ledger.rationale}</p>

      {/* The decision, not just the ranking. */}
      {ledger.decisive_test && (
        <div
          className={`mt-3 rounded-lg p-3 ${
            ledger.verdict === "ambiguous" ? "bg-warn-soft" : "bg-brand-soft"
          }`}
        >
          <div
            className={`text-[10px] font-bold uppercase tracking-wide ${
              ledger.verdict === "ambiguous" ? "text-warn" : "text-brand"
            }`}
          >
            {ledger.verdict === "ambiguous" ? "Do this first — the deciding test" : "Verify before acting"}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-ink/80">{ledger.decisive_test}</p>
        </div>
      )}

      {ledger.leading && ledger.runner_up && (
        <p className="mt-3 font-mono text-[10px] text-muted">
          Margin of victory {ledger.margin_of_victory} pts · {ledger.leading.label} {ledger.leading.score} vs{" "}
          {ledger.runner_up.label} {ledger.runner_up.score}
        </p>
      )}

      <div className="mt-3">
        {ledger.hypotheses.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-muted">
            No cause had enough basis in the data to score. Adding a companion metric, a segment split,
            or qualitative signal for this period would give the engine something to rank.
          </p>
        ) : (
          ledger.hypotheses.map((h, i) => (
            <Row
              key={h.id}
              h={h}
              rank={i + 1}
              weights={ledger.weights}
              open={open.has(h.id)}
              onToggle={() => toggle(h.id)}
            />
          ))
        )}
      </div>

      <p className="mt-3 border-t border-hairline pt-2.5 text-[10px] leading-relaxed text-muted">
        Weights are fixed ({ledger.weights.structured}/{ledger.weights.unstructured}/
        {ledger.weights.direction}/{ledger.weights.arithmetic}), so every score is decomposable and a
        cause supported by chatter alone cannot outrank one supported by records.
      </p>
    </div>
  );
}

/**
 * The step a dashboard never takes: from "this is why" to "do this, and here is what
 * it is worth."
 *
 * The posture is decided by the hypothesis ledger, not by tone. When the evidence
 * separates a cause, the plan prescribes remedies and attaches the amount the driver
 * decomposition actually measured. When it does not, the plan degrades on purpose —
 * to experiments that would discriminate between the surviving explanations, or to
 * collecting the data that is missing. Every row names an owner, a time to signal,
 * and a falsifiable check, so nothing here can be quietly declared a success.
 */
import type { ActionImpact, ActionPlan, PlannedAction } from "../types";

function money(v: number, unit: string): string {
  if (!Number.isFinite(v)) return "—";
  const p = unit === "USD" ? "$" : "";
  const a = Math.abs(v);
  const s = v < 0 ? "-" : "";
  if (a >= 1e12) return `${s}${p}${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${s}${p}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}${p}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}${p}${Math.round(a / 1e3)}k`;
  return `${s}${p}${Math.round(a)}`;
}

const POSTURE: Record<
  ActionPlan["posture"],
  { label: string; tone: "up" | "brand" | "warn" | "mute"; gloss: string }
> = {
  act: { label: "Act", tone: "up", gloss: "a cause survived its disconfirming tests" },
  test_first: { label: "Test first", tone: "warn", gloss: "two explanations are still within reach of each other" },
  gather_data: { label: "Gather data", tone: "mute", gloss: "the inputs cannot support a causal claim yet" },
  stand_down: { label: "Stand down", tone: "brand", gloss: "the move is inside its own normal pattern" },
};

const KIND: Record<PlannedAction["kind"], { label: string; cls: string }> = {
  test: { label: "test", cls: "border-warn/35 bg-warn/10 text-warn" },
  remedy: { label: "remedy", cls: "border-up/35 bg-up/10 text-up" },
  escalation: { label: "escalate", cls: "border-down/35 bg-down/10 text-down" },
  containment: { label: "contain", cls: "border-brand/35 bg-brand/10 text-brand" },
  data: { label: "data", cls: "border-hairline bg-white/5 text-white/70" },
  monitor: { label: "monitor", cls: "border-hairline bg-white/5 text-white/70" },
};

const TONE = {
  up: "text-up",
  brand: "text-brand",
  warn: "text-warn",
  mute: "text-white/70",
} as const;

function impactChip(impact: ActionImpact | null, unit: string) {
  if (!impact)
    return (
      <span className="rounded-md border border-white/5 px-2 py-0.5 font-mono text-[10px] text-white/40">
        not sized
      </span>
    );
  const cls =
    impact.kind === "recoverable"
      ? "border-up/35 bg-up/10 text-up"
      : impact.kind === "at_risk"
      ? "border-down/35 bg-down/10 text-down"
      : "border-hairline text-white/70";
  const suffix =
    impact.kind === "at_risk" ? " at risk" : impact.kind === "recoverable" ? " recoverable" : " exposure";
  return (
    <span className={`rounded-md border px-2 py-0.5 font-mono text-[10px] font-semibold ${cls}`} title={impact.basis}>
      {money(impact.value, impact.unit || unit)}
      {suffix}
    </span>
  );
}

export default function ActionPlanPanel({ plan }: { plan: ActionPlan }) {
  const p = POSTURE[plan.posture];

  return (
    <div className="panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="eyebrow">What to do next</div>
          <div className={`mt-1 font-display text-xl font-bold tracking-tight ${TONE[p.tone]}`}>
            {p.label}
            <span className="ml-2 align-middle text-[11px] font-medium normal-case tracking-normal text-muted">
              {p.gloss}
            </span>
          </div>
        </div>
        {plan.addressable && (
          <div className="rounded-lg border border-hairline bg-black/20 px-3 py-2 text-right">
            <div className="text-[10px] uppercase tracking-wider text-muted">
              {plan.addressable.kind === "at_risk" ? "Exposure measured" : "Addressable"}
            </div>
            <div className="font-mono text-lg font-bold leading-tight text-white">
              {money(plan.addressable.value, plan.addressable.unit || plan.unit)}
            </div>
            <div className="mt-0.5 max-w-[16rem] text-[10px] leading-snug text-muted">{plan.addressable.basis}</div>
          </div>
        )}
      </div>

      <p className="mt-2 text-xs leading-relaxed text-white/75">{plan.posture_reason}</p>

      <ol className="mt-4 space-y-2.5">
        {plan.actions.map((a) => (
          <li key={a.priority} className="rounded-lg border border-hairline bg-black/20 p-3.5">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-white/10 font-mono text-[11px] font-bold text-white">
                {a.priority}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] uppercase ${KIND[a.kind].cls}`}>
                    {KIND[a.kind].label}
                  </span>
                  {impactChip(a.impact, plan.unit)}
                  {a.serves && (
                    <span className="font-mono text-[10px] text-muted" title="the hypothesis this action serves">
                      serves: {a.serves}
                    </span>
                  )}
                </div>
                <p className="mt-1.5 text-sm leading-snug text-white">{a.action}</p>
                <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
                  <div className="text-muted">
                    Owner <span className="text-white/85">{a.owner}</span>
                  </div>
                  <div className="text-muted">
                    Signal in <span className="text-white/85">{a.time_to_signal}</span>
                  </div>
                  <div className="text-muted sm:col-span-2">
                    Check <span className="text-white/85">{a.check}</span>
                  </div>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ol>

      <p className="mt-3 border-t border-hairline pt-3 text-[11px] leading-relaxed text-muted">
        Amounts come from the driver decomposition, not from the plan. An action with no measured amount is shown as
        "not sized" rather than given an invented one.
      </p>
    </div>
  );
}

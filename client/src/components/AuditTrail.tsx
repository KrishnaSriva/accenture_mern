/**
 * The audit trail. Every number the story tells, traced back to the arithmetic that
 * produced it and the rows that fed the arithmetic.
 *
 * This is the panel that settles the question a business leader actually has about an
 * AI explanation — "did it work this out, or did it write something plausible?" Each
 * computation shows its inputs with their source, its formula, and its result. Where
 * the engine declined to compute something, the entry says so in place of a result,
 * which is the only honest way to render a gap.
 */
import { useState } from "react";
import type { Computation, Provenance } from "../types";

const SECTION_ORDER = ["detection", "attribution", "corroboration", "ruling", "confidence", "outlook"];

export default function AuditTrail({ provenance }: { provenance: Provenance }) {
  const [open, setOpen] = useState<string | null>(null);
  const sections = [...provenance.sections].sort(
    (a, b) => SECTION_ORDER.indexOf(a.id) - SECTION_ORDER.indexOf(b.id)
  );
  const withheld = sections.reduce(
    (n, s) => n + s.computations.filter((c) => c.withheld != null).length,
    0
  );
  const total = sections.reduce((n, s) => n + s.computations.length, 0);

  return (
    <div className="panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="eyebrow">Show the math</div>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-white/75">{provenance.llm_role}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-right text-muted">
          <div>
            <div>{total} computations</div>
            {withheld > 0 && <div className="text-warn">{withheld} withheld</div>}
          </div>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 border border-indigo-500/40 transition text-xs font-sans font-medium shadow-sm no-print"
          >
            <svg className="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            Export PDF Report
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Count label="KPI periods read" value={String(provenance.counts.kpi_periods)} />
        <Count label="order-level rows" value={provenance.counts.order_level_rows ? "available" : "none"} />
        <Count label="documents scored" value={String(provenance.counts.documents)} />
        <Count label="hypotheses ranked" value={String(provenance.counts.hypotheses_scored)} />
      </div>

      <div className="mt-4 divide-y divide-white/5 border-t border-hairline">
        {sections.map((s) => {
          const isOpen = open === s.id;
          const held = s.computations.filter((c) => c.withheld != null).length;
          return (
            <div key={s.id}>
              <button
                onClick={() => setOpen(isOpen ? null : s.id)}
                aria-expanded={isOpen}
                className="flex w-full items-center gap-3 py-3 text-left transition hover:bg-white/[0.03]"
              >
                <span className={`font-mono text-xs text-muted transition ${isOpen ? "rotate-90" : ""}`}>▸</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-white">{s.title}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted">{s.purpose}</span>
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted">
                  {s.computations.length}
                  {held > 0 && <span className="ml-1 text-warn">· {held} withheld</span>}
                </span>
              </button>

              <div className={isOpen ? "space-y-2.5 pb-4 pl-6" : "hidden print:block space-y-2.5 pb-4 pl-6"}>
                {s.computations.map((c) => (
                  <Row key={c.id} c={c} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <ul className="mt-4 space-y-1 border-t border-hairline pt-3">
        {provenance.guarantees.map((g, i) => (
          <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-muted">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand/60" />
            <span>{g}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Count({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-md border border-hairline bg-black/20 px-2 py-1 text-[10px] text-muted">
      <span className="font-mono font-semibold text-white/85">{value}</span> {label}
    </span>
  );
}

function Row({ c }: { c: Computation }) {
  return (
    <div className="rounded-lg border border-hairline bg-black/20 p-3">
      <div className="text-xs font-semibold text-white">{c.question}</div>
      <div className="mt-1 text-[11px] leading-relaxed text-muted">{c.method}</div>
      {c.formula && (
        <div className="mt-1.5 overflow-x-auto rounded bg-black/40 px-2 py-1 font-mono text-[10.5px] text-brand/90">
          {c.formula}
        </div>
      )}

      {c.inputs.length > 0 && (
        <dl className="mt-2 space-y-1">
          {c.inputs.map((inp, i) => (
            <div key={i} className="flex flex-wrap items-baseline gap-x-2 text-[10.5px]">
              <dt className="text-muted">{inp.name}</dt>
              <dd className="font-mono text-white/85">{inp.value}</dd>
              <dd className="text-white/35">← {inp.source}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-2 border-t border-white/10 pt-2 text-[11px]">
        {c.withheld ? (
          <span className="text-warn">
            <span className="font-semibold uppercase tracking-wide">withheld · </span>
            {c.withheld}
          </span>
        ) : (
          <span className="font-mono text-white">{c.result}</span>
        )}
      </div>
    </div>
  );
}

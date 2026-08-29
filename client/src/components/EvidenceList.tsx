import type { RetrievalResult } from "../types";

const THEME_LABEL: Record<string, string> = {
  software_bug: "Software bug",
  shipping_delay: "Shipping delay",
  product_quality: "Product quality",
  competitor: "Competitor",
};

const TYPE_LABEL: Record<string, string> = {
  review: "Review",
  support_ticket: "Support ticket",
  crm_note: "CRM note",
  sales_note: "Sales note",
};

export default function EvidenceList({ evidence }: { evidence: RetrievalResult }) {
  const spikes = evidence.theme_spikes;
  const anySpike = spikes.some((s) => s.spiking);

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between">
        <div className="eyebrow">Unstructured evidence</div>
        <span className="rounded-full border border-hairline px-2 py-0.5 text-[10px] font-medium text-muted">
          {evidence.method} · {evidence.doc_count} docs
        </span>
      </div>

      {/* theme spikes vs baseline — what jumped, what stayed flat */}
      <div className="mt-3 flex flex-wrap gap-2">
        {spikes.map((s) => (
          <div
            key={s.theme}
            className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
              s.spiking ? "border-down/30 bg-down/5" : "border-hairline bg-white/5"
            }`}
            title={`${s.count} this month vs ${s.baseline}/mo baseline`}
          >
            <span className={`font-medium ${s.spiking ? "text-down" : "text-white/70"}`}>
              {THEME_LABEL[s.theme] ?? s.theme}
            </span>
            <span className={`font-mono font-bold ${s.spiking ? "text-down" : "text-muted"}`}>
              {s.ratio}×
            </span>
            {s.spiking && <span className="text-[10px] font-semibold uppercase text-down">spike</span>}
          </div>
        ))}
      </div>

      {!anySpike && (
        <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
          No theme spiked above baseline this period — the qualitative signal does not point to a specific cause.
        </p>
      )}

      {/* negativity */}
      <div className="mt-3 flex items-center gap-2 text-xs text-muted">
        <span>Negative sentiment</span>
        <span className="font-mono font-semibold text-white/80">{Math.round(evidence.negative_share * 100)}%</span>
        <span>vs {Math.round(evidence.negative_baseline * 100)}% baseline</span>
      </div>

      {/* top retrieved documents */}
      <ul className="mt-4 space-y-2.5 border-t border-hairline pt-4">
        {evidence.top_documents.map((d) => (
          <li key={d.document_id} className="rounded-lg border border-hairline p-3 transition hover:border-brand/40 bg-surface">
            <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted">
              <span className="rounded bg-white/10 px-1.5 py-0.5 font-semibold text-white/90">{TYPE_LABEL[d.type] ?? d.type}</span>
              <span className="font-mono">{d.date}</span>
              {d.themes.map((t) => (
                <span key={t} className="rounded bg-down/10 px-1.5 py-0.5 font-medium text-down">
                  {THEME_LABEL[t] ?? t}
                </span>
              ))}
            </div>
            <p className="text-xs leading-relaxed text-white/85 print:text-slate-900 font-normal">{d.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

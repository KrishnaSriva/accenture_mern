import { marginBridge, mixContributions } from "./engine/aggregate";
import { buildLedger } from "./engine/hypotheses";
import { buildStory } from "./engine/story";
import { scoreConfidence } from "./engine/confidence";

const EMPTY_SEASONAL = { available:false, phase:null, cycle_label:null, prior_changes:[], typical:null, current:null, deviation:null, matches_pattern:false };
const ZERO = { units_prev:0, units_cur:0, price_prev:0, price_cur:0, volume_effect:0, price_effect:0, interaction:0, dominant:"mixed" as const };

const margin = marginBridge(
  { revenue: 100e9, gross_profit: 45e9, operating_expenses: 30e9 },
  { revenue: 95.7e9, gross_profit: 36e9, operating_expenses: 38e9 }
);
const aggregate: any = {
  available:true, period:"2026-06", prev_period:"2026-03", grain:"quarter", margin,
  kpi_deltas:[{kpi_key:"revenue",label:"Revenue",prev:100e9,cur:95.7e9,delta:-4.3e9,pct_change:-4.3}],
  mix: mixContributions([
    { key:"North America", prev:60e9, cur:55e9 },
    { key:"Europe", prev:25e9, cur:25.5e9 },
    { key:"Asia Pacific", prev:15e9, cur:15.2e9 },
  ]),
  mix_basis:"3 reported segments", concentration:116.28, seasonal:EMPTY_SEASONAL, notes:[],
};
const anomaly: any = { tier:"notable", zscore:-2.4, is_anomaly:true, direction:"down", pct_change:-4.3,
  prev_value:100e9, region:"Total", period:"2026-06", series:Array.from({length:20},(_,i)=>({period:`p${i}`,value:100})) };
const drivers: any = { by_recurring:[], by_segment:[], churn:{churned_count:0,churned_arr:0,by_reason:[]}, price_volume:ZERO, price_volume_software:ZERO };
const retrieval: any = { theme_spikes:[], top_documents:[] };

(async () => {
  const conf = scoreConfidence(anomaly, drivers, retrieval, aggregate);
  const ledger = buildLedger({ meta:{name:"Revenue",unit:"USD",higher_is_better:true}, anomaly, drivers, aggregate, retrieval });
  const story = await buildStory({ key:"revenue", name:"Revenue", unit:"USD", higher_is_better:true } as any,
    anomaly, drivers, retrieval, conf, { aggregate, ledger, plan: { actions: [] } as any });

  console.log("VERDICT:", ledger.verdict, "| leader:", ledger.leading?.id, ledger.leading?.score, "| margin:", ledger.margin_of_victory);
  console.log("\nRANKED:");
  for (const h of ledger.hypotheses) console.log(`  ${String(h.score).padStart(3)}  [${h.kind.padEnd(12)}] ${h.label}`);
  console.log("\nPRIMARY CAUSE:\n ", story.why.primary_cause);
  console.log("\nMECHANISM:\n ", story.why.mechanism);
  console.log("\nACTIONS:");
  story.recommended_actions.forEach((a,i)=>console.log(`  ${i+1}. ${a}`));
})();

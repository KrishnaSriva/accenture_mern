import type {
  AnalysisPayload,
  AnomalyResult,
  Company,
  ConnectSummary,
  Kpi,
  Region,
} from "./types";

// Same-origin in dev thanks to the Vite proxy (/api -> :4000).
const BASE = "/api";

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`GET ${path} failed (${r.status})`);
  return r.json() as Promise<T>;
}

const q = (company?: string) => (company ? `?company=${encodeURIComponent(company)}` : "");

export async function fetchKpis(company?: string): Promise<Kpi[]> {
  return get<Kpi[]>(`/kpis${q(company)}`);
}
export async function fetchRegions(company?: string): Promise<Region[]> {
  return get<Region[]>(`/regions${q(company)}`);
}
/**
 * Periods that actually have data for this company/region/kpi. Pass region+kpi
 * whenever they're known — connected companies mix quarterly (region "Total") and
 * annual (geo segments) grains, so the unfiltered list contains periods that
 * resolve to no datapoint for the selected region.
 */
export async function fetchPeriods(company?: string, region?: string, kpi?: string): Promise<string[]> {
  const params = new URLSearchParams();
  if (company) params.set("company", company);
  if (region) params.set("region", region);
  if (kpi) params.set("kpi", kpi);
  const qs = params.toString();
  return get<string[]>(`/periods${qs ? `?${qs}` : ""}`);
}

export async function analyze(
  kpi: string,
  region: string,
  period?: string,
  company = "DEMO"
): Promise<AnalysisPayload> {
  const r = await fetch(`${BASE}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kpi, region, period, company }),
  });
  const body = await r.json();
  if (!r.ok || !body.ok) throw new Error(body?.error || `analyze failed (${r.status})`);
  return body.result as AnalysisPayload;
}

export async function scan(kpi: string, period: string, company = "DEMO"): Promise<AnomalyResult[]> {
  const body = await get<{ ok: boolean; results: AnomalyResult[] }>(
    `/scan?kpi=${encodeURIComponent(kpi)}&period=${encodeURIComponent(period)}&company=${encodeURIComponent(company)}`
  );
  return body.results;
}

export interface CompaniesResponse {
  companies: Company[];
  sources: { fmp: boolean; newsapi: boolean; gnews: boolean };
}

export async function fetchCompanies(): Promise<CompaniesResponse> {
  const body = await get<{ ok: boolean } & CompaniesResponse>("/companies");
  return {
    companies: body.companies || [],
    sources: body.sources || { fmp: false, newsapi: false, gnews: false },
  };
}

export async function connectCompany(ticker: string): Promise<ConnectSummary> {
  const r = await fetch(`${BASE}/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticker }),
  });
  const body = await r.json();
  if (!r.ok || !body.ok) throw new Error(body?.error || `connect failed (${r.status})`);
  return body.summary as ConnectSummary;
}

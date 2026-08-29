/**
 * FRED (Federal Reserve Economic Data) connector.
 *
 *   Free key: https://fred.stlouisfed.org/docs/api/api_key.html
 *
 * Fetches macroeconomic series:
 *   - DEXUSEU: U.S. Dollars to Euro Exchange Rate (EMEA)
 *   - DEXJPUS: Japanese Yen to U.S. Dollar Exchange Rate (APAC)
 *   - DEXBZUS: Brazilian Reais to U.S. Dollar Exchange Rate (LATAM)
 *   - CPIAUCSL: Consumer Price Index for All Urban Consumers (NA / Inflation)
 *   - FEDFUNDS: Federal Funds Effective Rate
 *
 * Includes deterministic fallback series so the app runs 100% offline & without keys.
 */
import "dotenv/config";

export interface FredObservation {
  date: string;
  value: number;
}

export interface FredSeriesResult {
  series_id: string;
  title: string;
  units: string;
  observations: FredObservation[];
  source: "fred_api" | "offline_fallback";
}

export function fredConfigured(): boolean {
  return Boolean(process.env.FRED_API_KEY?.trim());
}

/** Region to FRED series mapping */
const REGION_SERIES: Record<string, { id: string; title: string; units: string }> = {
  EMEA: { id: "DEXUSEU", title: "U.S. / Euro Foreign Exchange Rate", units: "USD per EUR" },
  APAC: { id: "DEXJPUS", title: "Japanese Yen to U.S. Dollar Spot Exchange Rate", units: "JPY per USD" },
  LATAM: { id: "DEXBZUS", title: "Brazilian Reais to U.S. Dollar Spot Exchange Rate", units: "BRL per USD" },
  NA: { id: "CPIAUCSL", title: "U.S. Consumer Price Index (Inflation Benchmark)", units: "Index 1982-1984=100" },
  Total: { id: "CPIAUCSL", title: "U.S. Consumer Price Index (Inflation Benchmark)", units: "Index 1982-1984=100" },
};

/** Deterministic fallback data for demo periods */
const FALLBACK_SERIES: Record<string, Record<string, number>> = {
  DEXUSEU: {
    "2025-06": 1.085,
    "2025-07": 1.082,
    "2025-08": 1.079,
    "2025-09": 1.071,
    "2025-10": 1.065,
    "2025-11": 1.042, // -2.2% EUR drop in demo month
    "2025-12": 1.048,
  },
  DEXJPUS: {
    "2025-05": 155.2,
    "2025-06": 157.8,
    "2025-07": 154.1,
    "2025-08": 149.3,
    "2025-09": 143.5,
    "2025-10": 145.2,
    "2025-11": 147.1,
  },
  DEXBZUS: {
    "2025-09": 5.45,
    "2025-10": 5.52,
    "2025-11": 5.61,
  },
  CPIAUCSL: {
    "2025-09": 314.8,
    "2025-10": 315.6,
    "2025-11": 316.2,
  },
};

/** Pull FRED series for a region & target period */
export async function pullFRED(region: string, targetPeriod: string): Promise<FredSeriesResult> {
  const meta = REGION_SERIES[region] || REGION_SERIES["Total"];
  const apiKey = process.env.FRED_API_KEY?.trim();

  if (apiKey) {
    try {
      const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${meta.id}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=12`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as any;
        const obsRaw = data?.observations || [];
        const obs: FredObservation[] = obsRaw
          .map((o: any) => ({ date: o.date, value: parseFloat(o.value) }))
          .filter((o: FredObservation) => !isNaN(o.value));

        if (obs.length > 0) {
          return {
            series_id: meta.id,
            title: meta.title,
            units: meta.units,
            observations: obs,
            source: "fred_api",
          };
        }
      }
    } catch {
      // Fallback silently on network or key errors
    }
  }

  // Fallback offline observations
  const dataMap = FALLBACK_SERIES[meta.id] || FALLBACK_SERIES["DEXUSEU"];
  const observations: FredObservation[] = Object.entries(dataMap).map(([period, value]) => ({
    date: `${period}-01`,
    value,
  }));

  return {
    series_id: meta.id,
    title: meta.title,
    units: meta.units,
    observations,
    source: "offline_fallback",
  };
}

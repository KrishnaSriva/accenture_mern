/** Small, dependency-free robust statistics. */

export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median absolute deviation (raw, unscaled). */
export function mad(xs: number[]): number {
  if (!xs.length) return 0;
  const med = median(xs);
  return median(xs.map((x) => Math.abs(x - med)));
}

/**
 * Modified z-score of xs[targetIdx] vs the leave-one-out baseline, using the
 * scaled MAD (1.4826 * MAD ≈ std for normal data). Matches verify_data.py.
 */
export function modifiedZ(xs: number[], targetIdx: number): number {
  const x = xs[targetIdx];
  const rest = xs.filter((_, i) => i !== targetIdx);
  const med = median(rest);
  let scaledMad = 1.4826 * mad(rest);
  if (scaledMad === 0) scaledMad = 1e-9;
  return (0.6745 * (x - med)) / scaledMad;
}

export function tierOf(z: number): "significant" | "notable" | "normal" {
  const az = Math.abs(z);
  if (az >= 3.5) return "significant";
  if (az >= 2.0) return "notable";
  return "normal";
}

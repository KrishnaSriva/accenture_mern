import { useMemo } from "react";
import type { Point } from "../types";

interface Props {
  series: Point[];
  anomalyPeriod: string;
  direction: "up" | "down" | "flat";
  unit: string;
  effort?: number;
}

const W = 720;
const H = 240;
const PAD = { t: 18, r: 16, b: 26, l: 52 };

function compact(x: number, unit: string): string {
  if (!Number.isFinite(x)) return "—"; // never render "$NaN" on an axis label
  if (unit === "USD") {
    const a = Math.abs(x);
    if (a >= 1e12) return `$${(x / 1e12).toFixed(1)}T`;
    if (a >= 1e9) return `$${(x / 1e9).toFixed(1)}B`;
    if (a >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `$${Math.round(x / 1e3)}k`;
    return `$${Math.round(x)}`;
  }
  const a = Math.abs(x);
  if (a >= 1e12) return `${(x / 1e12).toFixed(1)}T`;
  if (a >= 1e9) return `${(x / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${Math.round(x / 1e3)}k`;
  return `${Math.round(x)}`;
}

function generateSmoothPath(pts: { cx: number; cy: number }[]) {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0].cx},${pts[0].cy}`;
  
  let path = `M${pts[0].cx.toFixed(1)},${pts[0].cy.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];
    
    const tension = 0.15;
    const cp1x = p1.cx + (p2.cx - p0.cx) * tension;
    const cp1y = p1.cy + (p2.cy - p0.cy) * tension;
    const cp2x = p2.cx - (p3.cx - p1.cx) * tension;
    const cp2y = p2.cy - (p3.cy - p1.cy) * tension;
    
    path += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.cx.toFixed(1)},${p2.cy.toFixed(1)}`;
  }
  return path;
}

export default function KpiChart({ series, anomalyPeriod, direction, unit, effort }: Props) {
  const { line, area, pts, projLine, projPts, yMin, yMax, aIdx, totalLength } = useMemo(() => {
    // Generate projections if effort is provided
    let extendedSeries = [...series];
    if (effort != null && series.length >= 2) {
      const pValue = series[series.length - 2].value;
      const cValue = series[series.length - 1].value;
      
      // If effort is 50%, it stays flat. If 100%, it recovers upward. If 0%, it drops.
      const multiplier = (effort / 50) - 1; 
      
      // Calculate a guaranteed visible delta based on the historical span (e.g., 30% of the max-min range)
      const historicalValues = series.map((p) => p.value);
      const histMin = Math.min(...historicalValues);
      const histMax = Math.max(...historicalValues);
      const span = histMax - histMin || cValue * 0.1 || 1;
      
      const potentialMove = span * 0.5; // Up to 50% of the historical span
      
      // Target delta always moves the line up or down based on the slider
      const targetDelta = potentialMove * multiplier;
      const targetValue = cValue + targetDelta;

      extendedSeries.push({ period: "Proj+1", value: cValue + (targetValue - cValue) * 0.33 });
      extendedSeries.push({ period: "Proj+2", value: cValue + (targetValue - cValue) * 0.66 });
      extendedSeries.push({ period: "Proj+3", value: targetValue });
    }

    const values = extendedSeries.map((p) => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const innerW = W - PAD.l - PAD.r;
    const innerH = H - PAD.t - PAD.b;
    
    const x = (i: number) => PAD.l + (extendedSeries.length <= 1 ? 0 : (i / (extendedSeries.length - 1)) * innerW);
    const y = (v: number) => PAD.t + innerH - ((v - min) / span) * innerH;
    
    const allPts = extendedSeries.map((p, i) => ({ ...p, cx: x(i), cy: y(p.value) }));
    
    const histPts = allPts.slice(0, series.length);
    const pPts = effort != null ? allPts.slice(series.length - 1) : [];

    const line = generateSmoothPath(histPts);
    const projLine = generateSmoothPath(pPts);
    
    const area = `${line} L${histPts[histPts.length - 1].cx.toFixed(1)},${(H - PAD.b).toFixed(1)} L${histPts[0].cx.toFixed(
      1
    )},${(H - PAD.b).toFixed(1)} Z`;
    
    return { 
      line, 
      area, 
      pts: histPts, 
      projLine, 
      projPts: pPts,
      yMin: min, 
      yMax: max, 
      aIdx: series.findIndex((p) => p.period === anomalyPeriod),
      totalLength: extendedSeries.length
    };
  }, [series, anomalyPeriod, effort, direction]);

  // Vibrant neon colors
  const accent = direction === "up" ? "#34d399" : direction === "down" ? "#f87171" : "#818cf8";
  const glowColor = direction === "up" ? "rgba(52, 211, 153, 0.5)" : direction === "down" ? "rgba(248, 113, 113, 0.5)" : "rgba(129, 140, 248, 0.5)";
  const a = aIdx >= 0 ? pts[aIdx] : null;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="KPI history with the analysed month highlighted">
      <defs>
        <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={accent} stopOpacity="0.4" />
          <stop offset="100%" stopColor={accent} stopOpacity="0.0" />
        </linearGradient>
        <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>

      {/* y gridlines + labels (min / mid / max) */}
      {[yMax, (yMax + yMin) / 2, yMin].map((v, i) => {
        const yy = PAD.t + (i / 2) * (H - PAD.t - PAD.b);
        return (
          <g key={i}>
            <line x1={PAD.l} y1={yy} x2={W - PAD.r} y2={yy} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
            <text x={PAD.l - 8} y={yy + 3} textAnchor="end" className="fill-muted" style={{ fontSize: 10, fontFamily: "JetBrains Mono" }}>
              {compact(v, unit)}
            </text>
          </g>
        );
      })}

      <path d={area} fill="url(#fill)" />
      <path d={line} fill="none" stroke={accent} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" filter="url(#glow)" />
      
      {effort != null && projLine && (
        <path 
          d={projLine} 
          fill="none" 
          stroke="#fde047" 
          strokeWidth="3" 
          strokeDasharray="4 6"
          strokeLinejoin="round" 
          strokeLinecap="round" 
          filter="url(#glow)" 
        />
      )}

      {/* small dots */}
      {pts.map((p, i) => (
        <circle key={`hist-${i}`} cx={p.cx} cy={p.cy} r={i === aIdx ? 0 : 1.6} fill={accent} opacity={0.5} />
      ))}
      {projPts.map((p, i) => (
        <circle key={`proj-${i}`} cx={p.cx} cy={p.cy} r={2} fill="#fde047" opacity={0.8} />
      ))}

      {/* anomaly marker */}
      {a && (
        <g>
          <line x1={a.cx} y1={PAD.t} x2={a.cx} y2={H - PAD.b} stroke={accent} strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
          <circle cx={a.cx} cy={a.cy} r="5.5" fill={accent} stroke="#fff" strokeWidth="2" />
          <text x={a.cx} y={PAD.t - 6} textAnchor="middle" fill={accent} style={{ fontSize: 11, fontFamily: "JetBrains Mono", fontWeight: 700 }}>
            {anomalyPeriod}
          </text>
        </g>
      )}

      {/* x labels: first, anomaly, last */}
      {[0, aIdx, totalLength - 1]
        .filter((i, idx, arr) => i >= 0 && arr.indexOf(i) === idx)
        .map((i) => {
          const isProj = i >= series.length;
          const p = isProj ? projPts[i - series.length + 1] : pts[i];
          if (!p) return null;
          return (
            <text
              key={i}
              x={p.cx}
              y={H - 8}
              textAnchor={i === 0 ? "start" : i === totalLength - 1 ? "end" : "middle"}
              className={isProj ? "fill-yellow-300" : "fill-muted"}
              style={{ fontSize: 10, fontFamily: "JetBrains Mono" }}
            >
              {p.period}
            </text>
          );
        })}
    </svg>
  );
}

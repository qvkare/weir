// The hero's backdrop: ridgelines drawn from the backtest's weekly H100 series (band cap, weekly
// average, band floor; backtest/results/site.json), so it reads as a landscape first and as price
// history on a second look. Pure: paths only; components/front/backdrop.tsx draws them.

export interface Ridge {
  /** A closed path: the ridge, then down to the bottom edge. */
  d: string;
  /** 0 is the farthest layer. */
  depth: number;
}

export const BACKDROP = { width: 1600, height: 640 };

/** Catmull-Rom through the points, as cubic Béziers. */
function smooth(pts: [number, number][]): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0]![0].toFixed(1)} ${pts[0]![1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0]!.toFixed(1)} ${c1[1]!.toFixed(1)} ${c2[0]!.toFixed(1)} ${c2[1]!.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

/**
 * One ridge per series, back to front. Each is scaled to its own height band, so the three sit
 * one behind another like hills; the x axis is the weeks, left to right.
 */
export function ridges(series: number[][]): Ridge[] {
  const { width: W, height: H } = BACKDROP;
  const bands: [number, number][] = [
    [300, 170], // far: base line, amplitude
    [395, 140],
    [490, 115],
  ];
  return series.slice(0, bands.length).flatMap((v, depth) => {
    const ok = v.filter((x) => Number.isFinite(x));
    if (ok.length < 2) return [];
    const min = Math.min(...ok);
    const max = Math.max(...ok);
    const [base, amp] = bands[depth]!;
    const span = max - min || 1;
    const step = (W + 80) / (v.length - 1);
    // A five-week moving average: hills, not steps.
    const sm = v.map((_, i) => {
      const w = v.slice(Math.max(0, i - 2), i + 3).filter((x) => Number.isFinite(x));
      return w.reduce((a, b) => a + b, 0) / (w.length || 1);
    });
    const pts = sm.map((x, i) => [i * step - 40, base - ((Number.isFinite(x) ? x : min) - min) / span * amp] as [number, number]);
    return [{ d: `${smooth(pts)}L${W + 40} ${H}L-40 ${H}Z`, depth }];
  });
}

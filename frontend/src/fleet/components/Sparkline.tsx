import { areaPoints, seriesPoints } from "../chart";
import "./chips.css";

/** A small shaded line of `values` across a `w` by `h` box. Decorative: the same number is in text beside it. */
export function Sparkline({ values, w, h }: { values: readonly number[]; w: number; h: number }) {
  const shade = areaPoints(values, w, h);
  const line = seriesPoints(values, w, h);
  return (
    <svg className="sp" width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <polyline className="area" points={shade} />
      <polyline points={line} />
    </svg>
  );
}

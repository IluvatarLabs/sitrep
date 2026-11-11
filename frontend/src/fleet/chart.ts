// Geometry for the hand-drawn SVG charts (no chart library): where a point sits, a series as polyline points, the point under
// the pointer, and a trailing mean.

const finite = (v: number): number => (Number.isFinite(v) ? v : 0);

/** Where point `i` of `n` sits across `width`; a lone point sits at the left edge. */
export const xOf = (i: number, n: number, width: number): number => (n > 1 ? (width * i) / (n - 1) : 0);

/**
 * `values` as polyline points in a `width` × `height` box, `pad` kept clear above and below. The scale tops out at `top`, else
 * at the largest value (1 at least), and values are clamped to it. One value draws a level line across; none, a line along the
 * bottom.
 */
export const seriesPoints = (values: readonly number[], width: number, height: number, top?: number, pad = 2): string => {
  const ceiling = top ?? Math.max(1, ...values.map(finite));
  const yOf = (v: number) => (height - pad - (Math.min(ceiling, Math.max(0, finite(v))) / ceiling) * (height - 2 * pad)).toFixed(1);
  if (values.length < 2) {
    const level = values.length === 1 ? yOf(values[0]!) : (height - pad).toFixed(1);
    return `0,${level} ${width},${level}`;
  }
  return values.map((v, i) => `${xOf(i, values.length, width).toFixed(1)},${yOf(v)}`).join(" ");
};

/** `values` as a closed polygon under the series line, for a shaded area. */
export const areaPoints = (values: readonly number[], width: number, height: number, top?: number, pad = 2): string =>
  `${seriesPoints(values, width, height, top, pad)} ${width},${height} 0,${height}`;

/** The mean of the newest `count` values (all of them when there are fewer); 0 for none. */
export function windowMean(values: readonly number[], count: number): number {
  const newest = count > 0 ? values.slice(-count) : [];
  return newest.length === 0 ? 0 : newest.reduce((sum, v) => sum + v, 0) / newest.length;
}

/** The index of the point under a pointer at `pointerX`, over a plot `width` wide that starts at `left`. */
export const indexAt = (pointerX: number, left: number, width: number, n: number): number =>
  n <= 1 || width <= 0 ? 0 : Math.min(n - 1, Math.max(0, Math.round(((pointerX - left) / width) * (n - 1))));

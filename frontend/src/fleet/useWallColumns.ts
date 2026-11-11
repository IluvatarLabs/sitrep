import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { wallColumns } from "./wallLayout";

/** Runs `onResize` now and on every change of the element's size; without ResizeObserver, on every change of the window's. */
export function watchSize(el: HTMLElement | null, onResize: () => void): () => void {
  onResize();
  if (el && typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(onResize);
    observer.observe(el);
    return () => observer.disconnect();
  }
  addEventListener("resize", onResize);
  return () => removeEventListener("resize", onResize);
}

/**
 * The Cards layout's column count, kept as its width changes (window, panes). `ref` goes on the element holding every group, so
 * the groups share their columns. Null until a width is known, so the CSS fallback applies.
 */
export function useWallColumns(): { ref: RefObject<HTMLDivElement>; cols: number | null } {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // Measured while mounted; a width known before stays when the element goes.
  useLayoutEffect(
    () =>
      watchSize(ref.current, () => {
        if (ref.current) setWidth(ref.current.clientWidth);
      }),
    [],
  );
  return { ref, cols: width > 0 ? wallColumns(width) : null };
}

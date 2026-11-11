// The separator between two panes (the WAI-ARIA window splitter): drag it, step it with the arrow keys (Shift for 48 px), or
// double-click, Home or Escape to reset.
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { keyWidth, LIMITS, type Panel, type Resizable } from "../useResizable";

export function ResizeHandle({ panel, r, container, label }: { panel: Panel; r: Resizable; container: () => HTMLElement | null; label: string }) {
  const dragging = useRef(false);
  const width = r.width(panel);
  const [min, max] = LIMITS[panel];

  /** The width a pointer at `x` asks for: the rail's from the frame's left edge, the inspector's from its right. */
  const widthAt = (x: number) => {
    const frame = container()?.getBoundingClientRect();
    if (!frame || !Number.isFinite(x)) return width;
    return panel === "rail" ? x - frame.left : frame.right - x;
  };
  /** A width shown and stored, or the default for undefined. */
  const commit = (to: number | undefined) => (to === undefined ? r.reset(panel) : r.set(panel, to, true));
  const drag = (handle: HTMLElement, on: boolean) => {
    dragging.current = on;
    handle.classList.toggle("drag", on);
    document.body.classList.toggle("shell-resizing", on);
  };
  const release = ({ currentTarget, clientX }: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    drag(currentTarget, false);
    commit(widthAt(clientX));
  };

  return (
    <div
      role="separator"
      className={`shell-rz shell-rz-${panel}`}
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      title="Drag to resize; double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        // Without pointer capture the drag still works while the pointer stays on the handle.
        const { currentTarget: handle, pointerId } = e;
        try {
          handle.setPointerCapture(pointerId);
        } catch {
          /* not available */
        }
        drag(handle, true);
      }}
      onPointerMove={(e) => {
        if (dragging.current) r.set(panel, widthAt(e.clientX), false);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onDoubleClick={() => commit(undefined)}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        const asked = keyWidth(panel, e.key, e.shiftKey, width);
        // null: not a key that resizes, so the page keeps it.
        if (asked === null) return;
        e.preventDefault();
        commit(asked);
      }}
    />
  );
}

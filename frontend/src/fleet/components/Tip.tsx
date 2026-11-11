// A note on a word or badge (the WAI-ARIA tooltip pattern): it opens on hover and on keyboard focus, closes on blur, on leaving
// while unfocused, and on Escape. Its text is always in the page as the trigger's description, so a screen reader reads it
// either way. The box is fixed and placed from the trigger's rectangle, so a scrolling table never clips it.
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/** The least room kept between the box and the window's edge, and between the box and its trigger. */
const EDGE = 8;
const OFFSET = 4;

/** Under the trigger, or over it when only over has room; never past the window's sides. */
function placed(trigger: DOMRect, box: DOMRect): CSSProperties {
  const below = trigger.bottom + OFFSET;
  const above = trigger.top - OFFSET - box.height;
  const top = below + box.height > innerHeight - EDGE && above >= EDGE ? above : below;
  return { top, left: Math.max(EDGE, Math.min(trigger.left, innerWidth - box.width - EDGE)) };
}

type Reason = "hover" | "focus";

export function Tip(props: { text: string; className?: string; style?: CSSProperties; children: ReactNode }) {
  const { text, className, style, children } = props;
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<HTMLSpanElement>(null);
  // What holds it open; Escape shuts it until it is entered or focused again.
  const [holding, setHolding] = useState<ReadonlySet<Reason>>(new Set());
  const [shut, setShut] = useState(false);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const open = holding.size > 0 && !shut;

  useLayoutEffect(() => {
    const [trigger, box] = [triggerRef.current, boxRef.current];
    setPlace(open && trigger && box ? placed(trigger.getBoundingClientRect(), box.getBoundingClientRect()) : null);
  }, [open, text]);

  // Opened by hover alone, nothing has focus to take Escape, so the document listens for it.
  useEffect(() => {
    if (!open) return undefined;
    const listening = new AbortController();
    document.addEventListener("keydown", (e) => e.key === "Escape" && setShut(true), { signal: listening.signal });
    return () => listening.abort();
  }, [open]);

  const hold = (reason: Reason, on: boolean) => {
    setHolding((was) => {
      const next = new Set(was);
      if (on) next.add(reason);
      else next.delete(reason);
      return next;
    });
    if (on) setShut(false);
  };
  return (
    <span
      ref={triggerRef}
      className={["tip", className].filter(Boolean).join(" ")}
      style={style}
      tabIndex={0}
      aria-describedby={id}
      onMouseEnter={() => hold("hover", true)}
      onMouseLeave={() => hold("hover", false)}
      onFocus={() => hold("focus", true)}
      onBlur={() => hold("focus", false)}
    >
      {children}
      <span ref={boxRef} id={id} role="tooltip" className="tipbox" hidden={!open} style={place ?? { visibility: "hidden" }}>
        {text}
      </span>
    </span>
  );
}

// A machine's plan windows, on its group's header (views/now/controls GroupHead): per provider, its logo and each window as "7d
// 81% used" (orange from 75 %, red from 90 %, limits.ts), then when it resets, muted. A stale reading is muted whole and says
// when it was taken in the reset's place ("as of 14:05"; the reset stays in its title). Nothing when the machine reports none.
import { limitFigure, limitLevel, limitWords, resetWords, staleWords } from "../limits";
import { providerInfo } from "../provider";
import type { MachineView } from "../types";
import { Unknown } from "../ui/Unknown";
import "./chips.css";

export function PlanWindows({ m, now }: { m: MachineView; now: number }) {
  const reported = m.rateLimits.filter((p) => p.limits.length > 0);
  if (reported.length === 0) return null;
  return (
    <span className="pw">
      {reported.map((p) => {
        const { Logo, name } = providerInfo(p.provider);
        return (
          <span key={p.provider} className="pw-provider">
            <Logo />
            <span className="ui-vh">{name}</span>
            {p.limits.map((l) => {
              const stale = staleWords(l, now);
              const reset = resetWords(l, now);
              return (
                <span key={l.kind} className="pw-win" data-stale={stale ? true : undefined} title={`${name} ${limitWords(l, p.provider, now)}`}>
                  <span className="pw-pct" data-level={stale ? undefined : limitLevel(l.percentUsed)}>
                    {limitFigure(l)}
                  </span>
                  <span>{stale ?? reset ?? <Unknown reason="Reset not reported" />}</span>
                </span>
              );
            })}
          </span>
        );
      })}
    </span>
  );
}

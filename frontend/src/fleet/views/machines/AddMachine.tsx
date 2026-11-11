// Add a machine, on the one panel: pick the OS and the harnesses, then the numbered steps with Copy, the install pointed at this
// page's origin (OPERATIONS Add a machine). It watches the live machine list and says when a new machine reports.
import { useId, useState } from "react";
import { IconCheck } from "../../components/Icons";
import { PROVIDER } from "../../provider";
import type { MachineView, Provider } from "../../types";
import { Panel } from "../../ui/Panel";
import { cloneCommand, Command, installCommand, OsPicker, type Os } from "./commands";

/** The machine being added is most often the one the browser runs on. */
const browserOs = (): Os => (/Mac/i.test(navigator.userAgent) ? "macos" : "linux");

export function AddMachine({ machines, onClose }: { machines: readonly MachineView[]; onClose: () => void }) {
  const titleId = useId();
  const harnessId = useId();
  const [os, setOs] = useState<Os>(browserOs);
  const [picked, setPicked] = useState<Record<Provider, boolean>>({ claude: true, codex: true });
  // The machines already known when the panel opened: the first one that is not is the new machine.
  const [known] = useState(() => new Set(machines.map((m) => m.id)));
  const arrived = machines.find((m) => !known.has(m.id));
  const { claude, codex } = picked;
  return (
    <Panel modal title="Add a machine" titleId={titleId} onClose={onClose} className="mc-add">
      <div className="mc-add-body">
        <div className="ui-field-row">
          <span>OS</span>
          <OsPicker value={os} onChange={setOs} label="OS" />
        </div>
        <div className="ui-field-row">
          <span id={harnessId}>Harness</span>
          <div className="ui-segment-options" role="group" aria-labelledby={harnessId}>
            {(["claude", "codex"] as const).map((p) => {
              const { Logo, app } = PROVIDER[p];
              const only = picked[p] && !picked[p === "claude" ? "codex" : "claude"];
              return (
                <button key={p} type="button" aria-pressed={picked[p]} disabled={only} onClick={() => setPicked({ ...picked, [p]: !picked[p] })}>
                  <Logo />
                  {app}
                </button>
              );
            })}
          </div>
        </div>
        <ol className="mc-steps">
          <li>
            <Command text={cloneCommand(codex)} />
          </li>
          <li>
            <Command text={installCommand(claude, codex, window.location.origin)} />
            <span className="mc-step-note">Paste the admin secret, then Ctrl-D</span>
          </li>
          {codex ? (
            <li className="mc-step-text">
              Codex hooks: <span className="mc-dim">trusted by the installer</span>
            </li>
          ) : null}
          {/* Linger keeps a user service running after logout; codex-reporter is the only one a reporter machine has. */}
          {codex && os === "linux" ? (
            <li>
              <Command text="loginctl enable-linger $USER" />
            </li>
          ) : null}
          {/* A Claude Code session reads its telemetry settings only at start: one already open is restarted, as /reload-plugins won't do. */}
          {claude ? (
            <li>
              <Command label="Claude sessions already open" note="quit each, then resume it" text="claude --resume" />
            </li>
          ) : null}
        </ol>
        <p className="mc-wait" role="status">
          {arrived ? (
            <>
              <IconCheck />
              {`${arrived.name} reported`}
            </>
          ) : (
            "Waiting for the first report…"
          )}
        </p>
      </div>
    </Panel>
  );
}

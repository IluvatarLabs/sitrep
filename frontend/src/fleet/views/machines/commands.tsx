// Every shell command the GUI hands out, in one place, from docs/OPERATIONS.md (Add a machine, Troubleshooting, Security,
// Off the LAN, Check a machine): the per-OS fix commands for a machine, the server's own, and the install steps. A command is
// shown on one row with Copy; the text itself also selects whole on one click.
import type { ReactNode } from "react";
import { IconCheck, IconCopy, osLogo } from "../../components/Icons";
import { useCopy } from "../../components/SessionId";
import "./machines.css";

export type Os = "macos" | "linux";

/** A machine's OS for its commands, from the name its reporter sends (as osLogo reads it): launchd on macOS, systemd otherwise. */
export const osOf = (os: string | null): Os => (/^(macos|mac os|os x|darwin)/i.test(os ?? "") ? "macos" : "linux");

export const OS_NAME: Record<Os, string> = { macos: "macOS", linux: "Linux" };

export interface CommandSpec {
  key: string;
  label: string;
  /** What to know before running it, after the label. */
  note?: string;
  text: string;
}

const CLONE = "~/sitrep";

/** Add a machine, step 1: the clone, its packages, and for Codex the reporter's build. */
export const cloneCommand = (codex: boolean): string =>
  `git clone https://github.com/IluvatarLabs/sitrep ${CLONE} && cd ${CLONE} && npm ci${codex ? " && npm run build -w codex-reporter" : ""}`;

/** Add a machine, step 2 (and a refused secret's fix): the reporters' install, the admin secret read from stdin. */
export const installCommand = (claude: boolean, codex: boolean, url: string): string =>
  `npx tsx scripts/install.ts${claude ? " --claude" : ""}${codex ? " --codex" : ""} --url ${url} --token-stdin --apply`;

/**
 * Update, in the clone: pull the new code and install its packages (building the Codex reporter where Codex runs), then run the
 * installer for each harness the machine reports. Codex's copies the new plugin into Codex's cache and trusts its hooks again;
 * Claude's writes Claude Code's telemetry settings, keeping the admin secret already on the machine (the installer says when
 * there is none, and doctor flags it; installCommand passes one with --token-stdin).
 */
function updateCommand(claude: boolean, codex: boolean): string {
  const pull = `git pull && npm ci${codex ? " && npm run build -w codex-reporter" : ""}`;
  if (!claude && !codex) return pull;
  return `${pull} && npx tsx scripts/install.ts${claude ? " --claude" : ""}${codex ? " --codex" : ""} --apply`;
}

/** The fix commands for one machine, run in its clone (OPERATIONS Troubleshooting and Upgrade), for the harnesses it reports. */
export function machineCommands(os: Os, claude: boolean, codex: boolean): CommandSpec[] {
  const mac = os === "macos";
  const rows: (CommandSpec | false)[] = [
    { key: "check", label: "Check", text: "npx tsx scripts/doctor.ts" },
    { key: "update", label: "Update", text: updateCommand(claude, codex) },
    // The installer's `claude plugin update` asks for a restart ("Restart to apply changes"), and Claude Code reads its telemetry
    // settings only when a session starts: each open session is quit and resumed, which keeps its conversation.
    claude && { key: "resume", label: "Then restart each open Claude Code session", note: "quit it, then resume it", text: "claude --resume" },
    codex && { key: "trust", label: "Trust the Codex hooks", text: "npx tsx scripts/install.ts --codex --apply" },
    codex && {
      key: "restart",
      label: "Restart codex-reporter",
      text: mac ? "launchctl kickstart -k gui/$(id -u)/dev.sitrep.codex-reporter" : "systemctl --user restart sitrep-codex-reporter",
    },
    codex && { key: "log", label: "codex-reporter log", text: mac ? "tail -n 50 ~/.sitrep/codex-reporter.log" : "journalctl --user -u sitrep-codex-reporter -e" },
    { key: "uninstall", label: "Uninstall", text: `npx tsx scripts/uninstall.ts${claude ? " --claude" : ""}${codex ? " --codex" : ""} --apply` },
  ];
  return rows.filter((r): r is CommandSpec => r !== false);
}

/**
 * The off-LAN tunnel (OPERATIONS Off the LAN), from this page's host: forward the server's port to where it listens, its own
 * loopback when it listens on every address, else its address.
 */
export function tunnelCommand(listen: string, port: number, pageHost: string): string {
  const target = listen === "0.0.0.0" || listen === "::" || listen === "" ? "127.0.0.1" : listen.includes(":") ? `[${listen}]` : listen;
  return `ssh -N -L ${port}:${target}:${port} ${pageHost}`;
}

/** The server's own commands (OPERATIONS Security, Files and services, Off the LAN, Check a machine). */
export function serverCommands(os: Os, listen: string, port: number, pageHost: string): CommandSpec[] {
  const mac = os === "macos";
  const env = "~/.sitrep/server.env";
  const restart = mac ? "launchctl kickstart -k gui/$(id -u)/dev.sitrep.server" : "systemctl --user restart sitrep";
  return [
    { key: "secret", label: "Read the admin secret", text: `sed -n 's/^SITREP_TOKEN=//p' ${env}` },
    {
      // The new secret never sits on a command line (ps shows those): sed only deletes the old line, and the shell's built-in
      // printf appends the new one.
      key: "rotate",
      label: "Rotate the admin secret",
      note: "then install every reporter again",
      text: `sed -i${mac ? " ''" : ""} '/^SITREP_TOKEN=/d' ${env} && printf 'SITREP_TOKEN=%s\\n' "$(openssl rand -hex 24)" >> ${env} && ${restart}`,
    },
    { key: "restart", label: "Restart", text: restart },
    { key: "logs", label: "Log", text: mac ? "tail -n 50 ~/.sitrep/server.log" : "journalctl --user -u sitrep -e" },
    { key: "tunnel", label: "Tunnel from off the LAN", text: tunnelCommand(listen, port, pageHost) },
    { key: "doctor", label: "Check a machine", text: "npx tsx scripts/doctor.ts" },
  ];
}

/** One command on one row: its label (and a note after it), the command, and Copy, which reads Copied or Copy failed a moment. */
export function Command({ label, note, text }: { label?: ReactNode; note?: ReactNode; text: string }) {
  const { state, copy } = useCopy(text);
  const Mark = state === "copied" ? IconCheck : IconCopy;
  return (
    <div className="cmd">
      {label === undefined ? null : (
        <span className="cmd-label">
          {label}
          {note ? <span className="cmd-note">{note}</span> : null}
        </span>
      )}
      <code className="cmd-text">{text}</code>
      <span className="cmd-copy">
        <button type="button" className="ui-button ui-button--icon" aria-label={typeof label === "string" ? `Copy: ${label}` : "Copy"} title="Copy" onClick={copy}>
          <Mark />
        </button>
        <span className="cmd-state" aria-live="polite">
          {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : ""}
        </span>
      </span>
    </div>
  );
}

/** macOS or Linux, as two pressed-or-not buttons with the OS logos. */
export function OsPicker({ value, onChange, label }: { value: Os; onChange: (os: Os) => void; label: string }) {
  return (
    <div className="ui-segment-options" role="group" aria-label={label}>
      {(["macos", "linux"] as const).map((os) => (
        <button key={os} type="button" aria-pressed={value === os} onClick={() => onChange(os)}>
          {osLogo(OS_NAME[os])}
          {OS_NAME[os]}
        </button>
      ))}
    </div>
  );
}

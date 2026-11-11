// The harnesses, once: the name the console calls each by, the app a session of it is answered in, and its maker's logo. The two
// the console knows have their own; any other name the server accepts (Hermes first) is shown by that name, with our generic
// monitor glyph, never as Claude or Codex.
import type { ComponentType } from "react";
import { isKnownProvider } from "../../../server/src/fleet/protocol";
import { IconMachine, LogoClaude, LogoOpenAI } from "./components/Icons";
import type { Provider, ProviderName } from "./types";

export interface ProviderInfo {
  /** "Claude", "Codex": the harness in labels and sentences. */
  name: string;
  /** "Claude Code", "Codex": the app a session is answered in. */
  app: string;
  Logo: ComponentType<{ className?: string }>;
}

/** The two harnesses with an entry of their own (protocol Provider). */
export const PROVIDER: Readonly<Record<Provider, ProviderInfo>> = {
  claude: { name: "Claude", app: "Claude Code", Logo: LogoClaude },
  codex: { name: "Codex", app: "Codex", Logo: LogoOpenAI },
};

/**
 * A harness as the console shows it, for every name the server accepts: its own entry (protocol isKnownProvider), else its
 * name as reported for its name and its app, and our generic monitor glyph (Icons IconMachine, the glyph for an OS nobody
 * named) for its logo; a place that shows only a logo also shows that name (Chips ModelChip).
 */
export function providerInfo(p: ProviderName): ProviderInfo {
  return isKnownProvider(p) ? PROVIDER[p] : { name: p, app: p, Logo: IconMachine };
}

/**
 * Where a session runs (SessionView.hostSurface: Claude Code's surface, or the Codex thread's originator as Codex writes it), as a
 * label only where it changes what the owner does: where to go to answer it, that nobody can (headless), that it runs detached
 * (background), or that a Codex thread is a Claude Code session's helper (which explains its look-alike name). A terminal is the
 * default and says nothing; a value not listed is shown as sent; an unknown (or blank) surface says nothing.
 */
const SURFACE = new Map<string, string | null>([
  ["terminal", null],
  ["desktop", "Desktop"],
  ["Codex Desktop", "Desktop"],
  ["vscode", "VS Code"],
  ["mobile", "Mobile"],
  ["codex-tui", "CLI"],
  ["Claude Code", "via Claude Code"],
  ["headless", "headless"],
  ["codex_exec", "headless"],
  ["background", "background"],
]);

export function surfaceLabel(surface: string | null): string | null {
  const value = surface?.trim() ?? "";
  if (value === "") return null;
  return SURFACE.has(value) ? (SURFACE.get(value) ?? null) : value;
}

/** A run nobody can answer by its surface: `claude -p` and the SDK (`headless`), `codex exec` (`codex_exec`). */
export const isHeadlessSurface = (surface: string | null): boolean => SURFACE.get(surface?.trim() ?? "") === "headless";

// The browser's requests that change something: signing in and out, reading and answering an ask, a message or command, and
// the signed-in owner's admin actions. Each carries the cross-site header and the sign-in cookie, an HttpOnly cookie
// the page never sees; the secret typed into the form is sent once and never kept.
import { ADMIN_BASE, type EditableSettings, type SettingsBody } from "../../../server/src/fleet/protocol";
import type { AskDetail, DashboardCommand, RespondMe } from "./types";

/** A header a page on another site cannot send without a preflight; every change carries it. */
export const RESPOND_HEADER = "X-Sitrep-Respond";
/** Single owner: the one name that signs in, with the admin secret. */
export const ADMIN_NAME = "Admin";

const RESPOND = "/api/fleet/respond";

/** The server said no: its status and its JSON body ({} when it sent none). The message is the body's `error`. */
class RespondError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    const said = body.error;
    super(typeof said === "string" ? said : `HTTP ${status}`);
  }
}
export { RespondError };

/** One same-origin request with the header, a JSON body when given; resolves to the parsed reply, or throws a RespondError. */
async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const hasBody = body !== undefined;
  const headers: Record<string, string> = hasBody ? { [RESPOND_HEADER]: "1", "Content-Type": "application/json" } : { [RESPOND_HEADER]: "1" };
  const res = await fetch(url, { method, credentials: "same-origin", headers, body: hasBody ? JSON.stringify(body) : undefined });
  const raw = await res.text();
  let reply: Record<string, unknown> = {};
  try {
    if (raw) reply = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Not JSON: the status is the whole answer.
  }
  if (!res.ok) throw new RespondError(res.status, reply);
  return reply as T;
}

const enc = encodeURIComponent;
const sessionUrl = (id: string) => `${RESPOND}/sessions/${enc(id)}`;
const askUrl = (sessionId: string, askId: string) => `${sessionUrl(sessionId)}/asks/${enc(askId)}`;

export const respondApi = {
  me: () => send<RespondMe>("GET", `${RESPOND}/me`),
  signIn: (secret: string) => send<{ ok: true; name: string; admin: boolean }>("POST", `${RESPOND}/sign-in`, { name: ADMIN_NAME, token: secret }),
  signOut: () => send<{ ok: true }>("POST", `${RESPOND}/sign-out`),
  /** Ends every sign-in the server holds, this browser's included. */
  signOutEverywhere: () => send<{ ok: true }>("POST", `${RESPOND}/sign-out-everywhere`),
  ask: (sessionId: string, askId: string) => send<AskDetail>("GET", askUrl(sessionId, askId)),
  answer: (sessionId: string, askId: string, body: Record<string, unknown>) => send<{ ok: true; deliveryId: string }>("POST", `${askUrl(sessionId, askId)}/answer`, body),
  message: (sessionId: string, body: { text: string } | { command: DashboardCommand }) => send<{ ok: true; deliveryId: string; queued: boolean }>("POST", `${sessionUrl(sessionId)}/messages`, body),
  discard: (deliveryId: string) => send<{ ok: true }>("DELETE", `${RESPOND}/deliveries/${enc(deliveryId)}`),
};

export type RespondApi = typeof respondApi;

/**
 * A change to the server settings: any of them, and any part of a nested group (PUT /settings takes a partial). A key sent as
 * null drops the stored value, so `server.env`'s (else the built-in default) applies again: Settings' Reset.
 */
export type SettingsPatch = {
  [K in keyof EditableSettings]?: EditableSettings[K] extends object ? { [P in keyof EditableSettings[K]]?: EditableSettings[K][P] | null } : EditableSettings[K] | null;
};

/** The owner's actions under ADMIN_BASE (protocol.ts lists them), signed in, through the same request as the answers. */
export const adminApi = {
  saveSettings: (patch: SettingsPatch) => send<SettingsBody>("PUT", `${ADMIN_BASE}/settings`, patch),
  removeMachine: (machineId: string) => send<{ removed: string[] }>("DELETE", `${ADMIN_BASE}/machines/${enc(machineId)}`),
  removeSilent: () => send<{ removed: string[] }>("POST", `${ADMIN_BASE}/machines/remove-silent`),
  deleteSession: (sessionId: string) => send<{ ok: true }>("DELETE", `${ADMIN_BASE}/sessions/${enc(sessionId)}`),
  /** A display name for the dashboard only; null goes back to the reported one. */
  rename: (sessionId: string, name: string | null) => send<{ ok: true }>("PUT", `${ADMIN_BASE}/sessions/${enc(sessionId)}/name`, { name }),
  /** A plain link downloads it: a GET needs only the cookie. */
  backupUrl: `${ADMIN_BASE}/backup`,
};

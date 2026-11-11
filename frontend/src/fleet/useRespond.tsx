// Who is signed in, and which session the answer panel is open for: one provider for the console, read by the views, the
// session page, the inspector and the top bar. The sign-in is an HttpOnly cookie, so the page only asks the server who it is
// (GET /respond/me) and never holds the secret. Signing in needs the admin secret alone, not answering, so the server
// is asked whatever its switches say.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RespondError, respondApi, type RespondApi } from "./respondApi";
import type { RespondMe, SessionView } from "./types";

export type SignInResult = "ok" | "wrong" | "empty" | "no-secret";

export interface RespondContext {
  api: RespondApi;
  /** The server's respond and activityFeed switches are both on, so answering is possible at all. */
  settingsOn: boolean;
  /** The server's last word on this browser's sign-in; null until it first answers. Answering also needs `me.enabled`. */
  me: RespondMe | null;
  /** A sign-in ended while the page was open: the next form says so once. */
  expired: boolean;
  /** Asks the server again, after a refusal that says the sign-in is gone. */
  refresh: () => Promise<void>;
  signIn: (secret: string) => Promise<SignInResult>;
  signOut: () => Promise<void>;
  /** The session the answer panel is open for. Closing it gives focus back to what opened it. */
  openFor: string | null;
  close: () => void;
  open: (sessionId: string, from?: HTMLElement | null) => void;
  /** A session as the live fleet has it now, not as the views hold it for their redraw interval; null when it is not live. */
  liveSession: (id: string) => SessionView | null;
  /** The server's clock as its last message gave it (FleetState.serverTime), which every `lastSeenAt` is in. */
  serverNow: () => number;
}

const RespondState = createContext<RespondContext | null>(null);

/** The console's answering state; null outside the provider, where nothing about answering shows. */
export const useRespond = (): RespondContext | null => useContext(RespondState);

/** How often the sign-in is checked, so one that ended is noticed before the next answer. */
const CHECK_MS = 60_000;

type SignIn = Pick<RespondContext, "me" | "expired" | "refresh" | "signIn" | "signOut">;

/** The server's word on the sign-in, asked at once, again whenever its switches change, and every CHECK_MS; signing in and out. */
function useSignIn(api: RespondApi, settingsOn: boolean): SignIn {
  const [seen, setSeen] = useState<{ me: RespondMe | null; expired: boolean }>({ me: null, expired: false });
  // Signed in at the last answer: signed out at the next means the sign-in ended.
  const wasIn = useRef(false);

  const refresh = useCallback(
    () =>
      api.me().then(
        (me) => {
          const ended = wasIn.current && !me.signedIn;
          wasIn.current = me.signedIn;
          setSeen((was) => ({ me, expired: was.expired || ended }));
        },
        () => undefined, // The server can't be reached: the last answer stands.
      ),
    [api],
  );

  // settingsOn is listed so a change of the server's switches asks again at once: `me.enabled` follows them.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), CHECK_MS);
    return () => clearInterval(timer);
  }, [refresh, settingsOn]);

  const signIn = useCallback(
    async (secret: string): Promise<SignInResult> => {
      if (!secret) return "empty";
      try {
        await api.signIn(secret);
      } catch (err) {
        if (!(err instanceof RespondError)) return "wrong";
        // The server has no admin secret to check against (respondRoutes.ts sign-in).
        if (err.status === 403 && err.message === "no admin secret") return "no-secret";
        return err.status === 400 ? "empty" : "wrong";
      }
      setSeen((was) => ({ ...was, expired: false }));
      await refresh();
      return "ok";
    },
    [api, refresh],
  );

  // Signing out on purpose is not a sign-in that ended. The server is asked again whether or not it took the sign-out; a
  // failure still reaches the caller afterwards.
  const signOut = useCallback(async (): Promise<void> => {
    let failure: { err: unknown } | null = null;
    try {
      await api.signOut();
    } catch (err) {
      failure = { err };
    }
    wasIn.current = false;
    setSeen((was) => ({ ...was, expired: false }));
    await refresh();
    if (failure) throw failure.err;
  }, [api, refresh]);

  return useMemo(() => ({ ...seen, refresh, signIn, signOut }), [seen, refresh, signIn, signOut]);
}

/**
 * The session the answer panel is open for, and the element focus goes back to when it closes. Opening while it is open
 * (stepping through the waits) keeps that element: the panel never closed.
 */
function usePanelTarget(): Pick<RespondContext, "openFor" | "open" | "close"> {
  const [target, setTarget] = useState<string | null>(null);
  const shown = useRef(false);
  const giveBack = useRef<HTMLElement | null>(null);
  const open = useCallback((id: string, opener?: HTMLElement | null) => {
    if (!shown.current) giveBack.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    shown.current = true;
    setTarget(id);
  }, []);
  // The panel calls this from its dialog's close event (shell/Sheet.tsx), once the page behind is no longer inert, so the
  // element that opened it can take focus again.
  const close = useCallback(() => {
    shown.current = false;
    setTarget(null);
    giveBack.current?.focus();
  }, []);
  return useMemo(() => ({ openFor: target, open, close }), [target, open, close]);
}

export function RespondProvider({ settingsOn, liveSession, serverNow, children }: Pick<RespondContext, "settingsOn" | "liveSession" | "serverNow"> & { children: ReactNode }) {
  const signIn = useSignIn(respondApi, settingsOn);
  const panel = usePanelTarget();
  const value = useMemo<RespondContext>(() => ({ api: respondApi, settingsOn, liveSession, serverNow, ...signIn, ...panel }), [settingsOn, liveSession, serverNow, signIn, panel]);
  return <RespondState.Provider value={value}>{children}</RespondState.Provider>;
}

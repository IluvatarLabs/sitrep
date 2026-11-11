// The message box at the foot of a session's page: a message, or one of the provider's commands (/clear after its
// confirmation, /compact), sent through the same respond API and sender as the answer panel's box (shell/answering). Here no
// ask's form is showing, so a message never stands in for an answer (the panel's rule: a reply replaces an ask only while its
// form shows). Signed out, the box is the one line to sign in.
import { useState, type Ref } from "react";
import { commandsOf, Compose, OffNote, type ComposeProps } from "../../components/Compose";
import { SignInPanel } from "../../components/SignIn";
import { providerInfo } from "../../provider";
import { canAnswer, cantReason } from "../../respond";
import { useSender } from "../../shell/answering";
import type { SessionView } from "../../types";
import { askFeedsNow } from "../../useActivityFeed";
import { useRespond } from "../../useRespond";

/** `footRef`: the box held at the page's foot, which the page measures so a row brought into view is never left under it. */
export function PageComposer({ s, footRef }: { s: SessionView; footRef?: Ref<HTMLElement> }) {
  const ctx = useRespond();
  const [draft, setDraft] = useState("");
  const [clearAsked, setClearAsked] = useState(false);
  // What was sent shows at once in the session's feeds open elsewhere (the inspector's).
  const { busy, error, run } = useSender(ctx, async () => askFeedsNow(s.id));
  if (!ctx) return null;
  const me = ctx.me;
  const verdict = canAnswer(s, null);
  const edge: "off" | "cant" | null = !ctx.settingsOn || !me?.enabled ? "off" : verdict === "ok" ? null : verdict;
  const { name: agent, app } = providerInfo(s.provider);
  const commands = commandsOf(s.provider);
  const send = async (text: string) => {
    const command = commands.find((c) => c.name === text);
    if (await run(() => ctx.api.message(s.id, command ? { command: command.command } : { text }))) setDraft("");
  };

  let body;
  if (edge) body = <OffNote edge={edge} reason={cantReason(s)} machine={s.machine.name} app={app} provider={s.provider} />;
  else if (!me?.signedIn) body = <SignInPanel lead="Sign in to send a message" />;
  else {
    const box: ComposeProps = { name: s.name, agent, commands, pending: null, busy, error, draft, onDraft: setDraft, onSend: (text) => void send(text), confirmClear: clearAsked, onConfirmClear: setClearAsked };
    body = <Compose {...box} />;
  }
  return (
    <section ref={footRef} className="sv-compose" aria-label={`Message ${s.name}`}>
      {body}
    </section>
  );
}

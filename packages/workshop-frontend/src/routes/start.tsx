import { useEffect, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAuthenticatedApi } from "../AuthContext";
import PrincipleStartFrame from "../components/PrincipleStartFrame";
import { homePromptFromSearch } from "../homePrompt";
import { getStoredSelectedModel } from "../modelSelection";
import { recordPrincipleStart, type PrincipleStart } from "../principleStart";
import { logRpcFailure } from "../rpcErrors";
import { useHomeHandOff } from "../useHomeHandOff";

// Principle: home's Ask Watts question opens here; the home route sends it on before it renders
// (principleStart.ts). From the first frame the person sees the question and Watts thinking, in the
// workspace's own frame, while its workspace and chat are made. Then the workspace takes over, and
// keeps the frame until the chat has loaded (GadgetEditor.tsx), and the chat keeps the question
// and Watts thinking until its history has (ChatInterface.tsx).

type StartSearch = { prompt?: string };

/** How long a start runs before the frame says it is still starting. */
const SLOW_START_MS = 8_000;

/** /start: home's question, started in a new workspace. */
export const Route = createFileRoute("/start")({
  component: StartPage,
  validateSearch: (search: Record<string, unknown>): StartSearch => ({
    prompt: homePromptFromSearch(search.prompt),
  }),
});

function StartPage() {
  return <StartPageContent prompt={Route.useSearch().prompt} />;
}

/**
 * Starts `prompt` in a new workspace with the person's saved model, as Send on the home page would,
 * if home handed it over. Any other visit, a reload or a second visit gives it to the home composer.
 */
export function StartPageContent({ prompt }: StartSearch) {
  const question = useHomeHandOff(prompt);
  const { authenticatedApi } = useAuthenticatedApi();
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [slow, setSlow] = useState(false);
  // Whether /start is still on screen. A start runs on through re-renders, and stops only here.
  const mounted = useRef(false);
  // The attempt last begun. Only Try again begins another: a re-render with a new API or navigate
  // must not send the question again.
  const begun = useRef<number | null>(null);
  // A chat already started, so Try again after a failed move opens it rather than another.
  const started = useRef<PrincipleStart | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (question === undefined) navigate({ to: "/", search: { prompt }, replace: true });
  }, [navigate, prompt, question]);

  useEffect(() => {
    if (question === undefined) return;
    const timer = setTimeout(() => setSlow(true), SLOW_START_MS);
    return () => clearTimeout(timer);
  }, [attempt, question]);

  useEffect(() => {
    if (question === undefined) return;
    // A turn later, so StrictMode's trial mount, unmounted at once, starts nothing.
    const timer = setTimeout(async () => {
      if (begun.current === attempt) return;
      begun.current = attempt;
      try {
        if (!started.current) {
          const workspace = authenticatedApi.newWorkspace();
          try {
            const models = await authenticatedApi.listModels();
            if (!mounted.current) return;
            // Pipeline both independent calls in one batch, and settle both before the stub goes.
            const [chat, { id }] = await Promise.all([
              workspace.newChat(question, getStoredSelectedModel(models)),
              workspace.getMetadata(),
            ]);
            started.current = { id, chat, question };
          } finally {
            workspace[Symbol.dispose]();
          }
        }
        if (!mounted.current) return;
        recordPrincipleStart(started.current);
        const { id, chat } = started.current;
        await navigate({ to: "/workspace/$id", params: { id }, search: { chat }, replace: true });
      } catch (err) {
        if (!mounted.current) return;
        logRpcFailure("Failed to create gadget:", err, { reportSite: "workspace.create" });
        setFailed(true);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [attempt, authenticatedApi, navigate, question]);

  if (question === undefined) return null;
  return (
    <PrincipleStartFrame
      question={question}
      slow={slow}
      failed={failed}
      onRetry={() => {
        setFailed(false);
        setSlow(false);
        setAttempt((previous) => previous + 1);
      }}
    />
  );
}

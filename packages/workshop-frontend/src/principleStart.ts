import { useEffect, useState } from "react";
import { redirect, useRouterState } from "@tanstack/react-router";
import { homeHandOff, homePromptFromSearch } from "./homePrompt";

// Principle: home's Ask Watts question opens a chat at /start (routes/start.tsx), which shows the
// question and Watts thinking from the first frame. These are the hooks Cloudflare's files call:
// the home route sends the question on before it renders, the root shows the start's frame where it
// would show a spinner, the workspace editor shows it until the started chat has loaded, and the
// chat shows it until its history has.

/** Where home's question goes to be started. */
export const PRINCIPLE_START_PATH = "/start";

/** The home route's beforeLoad: a question home handed over goes to /start before home renders. */
export function redirectHomeHandOff({ search }: { search: { prompt?: string } }): void {
  const question = homeHandOff(search.prompt);
  if (question !== undefined) {
    throw redirect({ to: PRINCIPLE_START_PATH, search: { prompt: question }, replace: true });
  }
}

/** The question the root shows the start's frame for before /start itself renders, if any. */
export function usePrincipleStartQuestion(): string | undefined {
  const prompt = useRouterState({
    select: (state) => state.location.pathname === PRINCIPLE_START_PATH
      ? (state.location.search as { prompt?: unknown } | undefined)?.prompt
      : undefined,
  });
  return homeHandOff(homePromptFromSearch(prompt));
}

/** A chat /start opened: workspace `id`, its chat `chat`, and the question sent into it. */
export type PrincipleStart = { id: string; chat: number; question: string };

/** The chat /start opened last, in this page only: a reload forgets it. */
let started: PrincipleStart | null = null;

/** Remembers the chat /start opened. */
export function recordPrincipleStart(start: PrincipleStart): void {
  started = start;
}

/** The chat /start opened in workspace `id`, until that workspace has loaded. */
export function principleStartFor(id: string | undefined): PrincipleStart | undefined {
  return started !== null && started.id === id ? started : undefined;
}

/** Forgets the chat /start opened in workspace `id`. */
export function clearPrincipleStart(id: string): void {
  if (started?.id === id) started = null;
}

/** The question /start sent into workspace `id` while it loads; forgotten once it has `loaded`. */
export function usePrincipleStart(id: string | undefined, loaded: boolean): string | undefined {
  useEffect(() => {
    if (loaded && id !== undefined) clearPrincipleStart(id);
  }, [id, loaded]);
  return loaded ? undefined : principleStartFor(id)?.question;
}

/**
 * The question /start sent into chat `chatId` of workspace `id`, until that chat's history has
 * loaded. The chat takes it as it mounts, under the editor's cover and so before the editor forgets
 * the start, which it does once the chat list has loaded: often before the history has.
 */
export function usePrincipleStartHistory(
  id: string | undefined,
  chatId: number | null,
  historyLoaded: boolean,
): string | undefined {
  const [start] = useState(() => principleStartFor(id));
  return start?.chat === chatId && !historyLoaded ? start.question : undefined;
}

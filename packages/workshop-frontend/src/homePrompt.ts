import { defaultParseSearch } from "@tanstack/react-router";
import { MAX_GATEKEEPER_APP_PROMPT_LENGTH } from "./gatekeeperAppNavigation";

export function homePromptFromSearch(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const prompt = value.trim();
  if (!prompt || prompt.length > MAX_GATEKEEPER_APP_PROMPT_LENGTH) return undefined;
  return prompt;
}

// Principle: the home page's Ask Watts hands a question over to be sent, not typed. Only home may
// do that; any other page, or link, still only fills the composer.
const HOME_ORIGIN = "https://home.principlesvc.app";
const DEV_HOME_ORIGIN = "http://localhost:3020";

/**
 * Whether `prompt` was handed over by home to send at once: the page was opened from home, as a
 * fresh navigation (not a reload or back), at an address that asked to send this same prompt.
 * Links inside the app keep the page's referrer, which is why the opening address must match too.
 */
export function handedOverFromHome(
  prompt: string | undefined,
  { referrer, arrival, dev }: {
    referrer: string;
    arrival: Pick<PerformanceNavigationTiming, "name" | "type"> | undefined;
    dev: boolean;
  },
): boolean {
  if (!prompt || arrival?.type !== "navigate") return false;
  const from = urlOf(referrer)?.origin;
  if (from !== HOME_ORIGIN && !(dev && from === DEV_HOME_ORIGIN)) return false;
  const opened = urlOf(arrival.name);
  if (opened?.pathname !== "/") return false;
  const search: Record<string, unknown> = defaultParseSearch(opened.search);
  return search.send === 1 && homePromptFromSearch(search.prompt) === prompt;
}

function urlOf(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** Set once this page has given out home's question: it is opened once, so it hands over once. */
let handOffTaken = false;

/**
 * The question home handed this page as it opened, given to the first caller only. The home route
 * claims it as it mounts, so leaving before it is sent and coming back only fills the composer.
 */
export function homeHandOff(prompt: string | undefined): string | undefined {
  if (handOffTaken) return undefined;
  const arrival = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (!handedOverFromHome(prompt, { referrer: document.referrer, arrival, dev: import.meta.env.DEV })) {
    return undefined;
  }
  handOffTaken = true;
  return prompt;
}

import { createAssistantMessageEventStream, type AssistantMessageEvent, type Message, type Usage }
  from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ModelHandle } from "./ai-models.js";
import { createWorkshopLogger } from "./observability.js";

const logger = createWorkshopLogger("workshop.ai-invoke");

/**
 * An all-zeros pi Usage record, for synthesizing assistant messages that were never actually
 * produced by a live model call (chat-history replay, compaction prompts).
 */
export function zeroUsage(): Usage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * A failed model request, thrown by completeText() and the agent turn loop. pi never throws for
 * provider failures -- it reports them as a final assistant message with stopReason "error" --
 * so this converts that shape back into an exception for callers that expect one (the overseer's
 * turn error triage and the one-shot completion helpers).
 */
export class AgentTurnError extends Error {
  /** HTTP status of the failing request, when the handle observed a response for it. */
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Best-effort HTTP status extraction for a failed request. pi reports provider failures as
 * error text only, and its onResponse callback never fires for a request the SDK failed (so
 * ModelHandle.lastResponse is unset then) -- but the provider SDKs' error messages conventionally
 * begin with the status code (e.g. "400 {...}"), which is enough for the overseer's triage
 * (report 5xx/unknown, skip expected 4xx).
 */
export function httpStatusFromError(errorMessage: string, handle: ModelHandle)
    : number | undefined {
  const match = /^(\d{3})\b/.exec(errorMessage.trim());
  if (match) return Number(match[1]);
  return handle.lastResponse?.status;
}

/**
 * Run a single non-streaming-style completion against a ModelHandle and return the response
 * text. Used for one-shot calls: title generation, binding naming, compaction summaries, and
 * LanguageModelBinding.run. Always requests thinking off (one-shots should be quick, and none
 * of them benefit from extended thinking; pre-pi, these calls never configured thinking either).
 * Throws AgentTurnError on provider failure, or the abort reason when `signal` fired.
 */
export async function completeText(handle: ModelHandle, args: {
  systemPrompt?: string;
  /** Convenience: wraps into a single user message. Exactly one of `prompt`/`messages` required. */
  prompt?: string;
  messages?: Message[];
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const messages: Message[] = args.messages ??
      [{ role: "user", content: args.prompt ?? "", timestamp: Date.now() }];
  const stream = await handle.stream(handle.model, {
    systemPrompt: args.systemPrompt,
    messages,
  }, {
    maxTokens: args.maxTokens,
    signal: args.signal,
    thinking: false,
  });
  const message = await stream.result();
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    // Surface a cancellation as the abort reason, like a directly-aborted request would.
    args.signal?.throwIfAborted();
    const errorMessage = message.errorMessage ?? "The model request failed.";
    throw new AgentTurnError(errorMessage, httpStatusFromError(errorMessage, handle));
  }
  return message.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("");
}

/**
 * Backoff between attempts at a model request the provider refused with HTTP 429. Three retries,
 * so a turn waits at most 30s for a rate limit to clear before the error reaches the user.
 */
export const RATE_LIMIT_BACKOFF_MS: readonly number[] = [2000, 8000, 20000];

/**
 * Whether a failed request was a rate limit. pi reports the provider error as text only; the
 * SDKs' messages begin with the status ("429 {...}"), and OpenAI's wholesale limit and
 * Anthropic's both say "rate limit" somewhere in the body. `lastResponse` covers the case where
 * a response arrived but the message does not lead with its status.
 */
export function isRateLimitError(errorMessage: string, handle: ModelHandle): boolean {
  return httpStatusFromError(errorMessage, handle) === 429 ||
      /\brate.?limit/i.test(errorMessage);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wraps a handle's `stream` for the agent loop so a request the provider rate-limits (HTTP 429)
 * is retried with RATE_LIMIT_BACKOFF_MS before the error surfaces as the turn's failure. Only a
 * request that failed before producing any content is retried: once text, thinking or a tool call
 * has streamed to the client, the failure is passed through as pi reports it. Each retry logs
 * `agent.model.ratelimited`. `sleep` is injectable for tests.
 */
export function withRateLimitRetry(handle: ModelHandle, opts: {
  chatId?: number;
  backoffMs?: readonly number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
} = {}): StreamFn {
  const backoff = opts.backoffMs ?? RATE_LIMIT_BACKOFF_MS;
  const wait = opts.sleep ?? sleep;
  return (model, context, options) => {
    const out = createAssistantMessageEventStream();
    const signal = options?.signal;
    void (async () => {
      for (let attempt = 0; ; ++attempt) {
        // Events before the first content are held back until the request either produces
        // content (then they are forwarded and the stream passes through) or fails.
        const held: AssistantMessageEvent[] = [];
        let passthrough = false;
        let retry = false;
        for await (const event of await handle.stream(model, context, options)) {
          if (passthrough) {
            out.push(event);
            continue;
          }
          if (event.type === "error" && attempt < backoff.length && !signal?.aborted &&
              isRateLimitError(event.error.errorMessage ?? "", handle)) {
            const delayMs = backoff[attempt];
            logger.warn("model request rate limited; retrying", {
              event: "agent.model.ratelimited", chatId: opts.chatId, attempt: attempt + 1,
              maxAttempts: backoff.length, delayMs, modelId: model.id,
              statusCode: httpStatusFromError(event.error.errorMessage ?? "", handle),
            });
            await wait(delayMs, signal);
            // Cancelled while waiting: no retry; the failure is reported as pi produced it and
            // the loop turns it into the abort reason.
            retry = !signal?.aborted;
            if (retry) break;
          }
          held.push(event);
          if (event.type !== "start") {
            passthrough = true;
            for (const heldEvent of held) out.push(heldEvent);
            held.length = 0;
          }
        }
        if (retry) continue;
        for (const heldEvent of held) out.push(heldEvent);
        return;
      }
    })();
    return out;
  };
}

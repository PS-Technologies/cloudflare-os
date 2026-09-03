// The agent loop's rate-limit retry. pi never throws for a provider failure: the stream ends
// with an `error` event whose message carries the SDK's text ("429 {...}", "Wholesale Rate
// limited"). withRateLimitRetry re-issues such a request with backoff before letting the failure
// reach the loop, and leaves every other failure, and any failure after content streamed, alone.

import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent }
  from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import { RATE_LIMIT_BACKOFF_MS, isRateLimitError, withRateLimitRetry } from "../src/ai-invoke.js";
import type { ModelHandle } from "../src/ai-models.js";

const MODEL = { id: "test-model", api: "openai-completions" } as unknown as Model<Api>;

function assistant(extra: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant", content: [], api: "openai-completions", provider: "openai",
    model: "test-model", stopReason: "stop", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
             cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...extra,
  } as AssistantMessage;
}

const failure = (errorMessage: string): AssistantMessageEvent[] => [
  { type: "start", partial: assistant({}) },
  { type: "error", reason: "error", error: assistant({ stopReason: "error", errorMessage }) },
];
const success = (text: string): AssistantMessageEvent[] => {
  let message = assistant({ content: [{ type: "text", text }] });
  return [
    { type: "start", partial: message },
    { type: "text_start", contentIndex: 0, partial: message },
    { type: "text_delta", contentIndex: 0, delta: text, partial: message },
    { type: "text_end", contentIndex: 0, content: text, partial: message },
    { type: "done", reason: "stop", message },
  ];
};

/** A handle whose successive requests play the given event scripts. */
function scriptedHandle(scripts: AssistantMessageEvent[][]) {
  let calls = 0;
  let handle: ModelHandle = {
    model: MODEL,
    stream: () => {
      let events = scripts[calls++];
      if (!events) throw new Error("more model requests than scripted responses");
      let stream = createAssistantMessageEventStream();
      // Async, as a real request is: nothing is queued when the caller gets the stream.
      void Promise.resolve().then(() => { for (let event of events) stream.push(event); });
      return stream;
    },
  };
  return { handle, calls: () => calls };
}

async function run(scripts: AssistantMessageEvent[][], signal?: AbortSignal) {
  let { handle, calls } = scriptedHandle(scripts);
  let slept: number[] = [];
  let stream = await withRateLimitRetry(handle, {
    chatId: 7, sleep: async ms => { slept.push(ms); },
  })(MODEL, { messages: [] }, { signal });
  let events: string[] = [];
  for await (let event of stream) events.push(event.type);
  return { message: await stream.result(), events, slept, calls: calls() };
}

describe("isRateLimitError", () => {
  const handle = { model: MODEL, stream: () => { throw new Error(); } } as ModelHandle;
  it("recognizes the status prefix, the wording, and an observed 429", () => {
    expect(isRateLimitError('429 {"error":{"message":"Wholesale Rate limited"}}', handle)).toBe(true);
    expect(isRateLimitError("Wholesale Rate limited", handle)).toBe(true);
    expect(isRateLimitError("rate_limit_error: This request would exceed your rate limit", handle))
        .toBe(true);
    expect(isRateLimitError("Provider returned error", { ...handle, lastResponse: { status: 429 } }))
        .toBe(true);
  });
  it("leaves other failures alone", () => {
    expect(isRateLimitError("500 Internal Server Error", handle)).toBe(false);
    expect(isRateLimitError("400 {\"error\":\"invalid_request\"}", handle)).toBe(false);
  });
});

describe("withRateLimitRetry", () => {
  it("retries a 429 with 2s, 8s, 20s backoff and then surfaces it", async () => {
    let r = await run([
      failure("429 Wholesale Rate limited"), failure("429 Wholesale Rate limited"),
      failure("429 Wholesale Rate limited"), failure("429 Wholesale Rate limited"),
    ]);
    expect(r.calls).toBe(4);
    expect(r.slept).toEqual([...RATE_LIMIT_BACKOFF_MS]);
    expect(r.message.stopReason).toBe("error");
    expect(r.message.errorMessage).toBe("429 Wholesale Rate limited");
    // The client saw one start and one error, not one per attempt.
    expect(r.events).toEqual(["start", "error"]);
  });

  it("streams the successful retry as if it were the first request", async () => {
    let r = await run([failure("429 Wholesale Rate limited"), success("hello")]);
    expect(r.calls).toBe(2);
    expect(r.slept).toEqual([2000]);
    expect(r.message.stopReason).toBe("stop");
    expect(r.events).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
  });

  it("does not retry a failure that is not a rate limit", async () => {
    let r = await run([failure("500 upstream connect error")]);
    expect(r.calls).toBe(1);
    expect(r.slept).toEqual([]);
    expect(r.message.errorMessage).toBe("500 upstream connect error");
  });

  it("does not retry once content has streamed", async () => {
    let message = assistant({});
    let r = await run([[
      { type: "start", partial: message },
      { type: "text_start", contentIndex: 0, partial: message },
      { type: "text_delta", contentIndex: 0, delta: "partial", partial: message },
      { type: "error", reason: "error",
        error: assistant({ stopReason: "error", errorMessage: "429 Wholesale Rate limited" }) },
    ]]);
    expect(r.calls).toBe(1);
    expect(r.slept).toEqual([]);
    expect(r.events).toEqual(["start", "text_start", "text_delta", "error"]);
  });

  it("stops retrying when the turn is cancelled during the wait", async () => {
    let controller = new AbortController();
    let { handle, calls } = scriptedHandle([failure("429 Wholesale Rate limited")]);
    let stream = await withRateLimitRetry(handle, {
      sleep: async () => { controller.abort(); },
    })(MODEL, { messages: [] }, { signal: controller.signal });
    let message = await stream.result();
    expect(calls()).toBe(1);
    expect(message.stopReason).toBe("error");
  });
});

// What Stop does to a code execution parked inside a binding call: the execution ends for the
// chat at once, the isolate's capabilities are dropped, and the person gets their composer back.
// Before this, the stop signal was checked only between tool calls, so a code block waiting on
// a thirty-minute browser handoff held the whole chat until the handoff returned.

import { describe, expect, it } from "vitest";
import { EXECUTION_STOPPED_MESSAGE, raceRunWithStop } from "../src/overseer.js";

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  let promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("raceRunWithStop", () => {
  it("returns the execution's result when nobody stops it", async () => {
    let controller = new AbortController();
    let disposed = 0;
    await expect(raceRunWithStop(Promise.resolve("log"), controller.signal, () => { disposed++; }))
        .resolves.toBe("log");
    expect(disposed).toBe(0);
  });

  it("ends a parked execution when Stop is clicked, and drops its capabilities", async () => {
    let controller = new AbortController();
    let run = pending<string>();
    let disposed = 0;
    let raced = raceRunWithStop(run.promise, controller.signal, () => { disposed++; });

    controller.abort(new Error("User requested to stop agent."));
    await expect(raced).rejects.toThrow(EXECUTION_STOPPED_MESSAGE);
    expect(disposed).toBe(1);

    // The orphaned execution failing later is nobody's problem: no unhandled rejection.
    run.reject(new Error("binding call cancelled"));
    await Promise.resolve();
  });

  it("refuses to start when the turn was already stopped", async () => {
    let controller = new AbortController();
    controller.abort();
    let disposed = 0;
    await expect(raceRunWithStop(new Promise<string>(() => {}), controller.signal,
        () => { disposed++; }))
        .rejects.toThrow(EXECUTION_STOPPED_MESSAGE);
    expect(disposed).toBe(1);
  });

  it("passes the execution's own failure through when nobody stopped it", async () => {
    let controller = new AbortController();
    let disposed = 0;
    await expect(raceRunWithStop(Promise.reject(new Error("TypeError: x is not a function")),
        controller.signal, () => { disposed++; }))
        .rejects.toThrow("x is not a function");
    expect(disposed).toBe(0);
  });

  it("is a plain await without a signal", async () => {
    await expect(raceRunWithStop(Promise.resolve(7), undefined, () => {
      throw new Error("must not dispose");
    })).resolves.toBe(7);
  });
});

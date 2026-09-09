import { describe, expect, it } from "vitest";
import { resolveSessionActor } from "../src/actor.js";

const VERIFIER = {} as Fetcher<never>;

describe("resolveSessionActor", () => {
  it("returns undefined for a headless caller", async () => {
    await expect(resolveSessionActor(
        undefined, 1, "test", undefined, undefined, async () => VERIFIER))
        .resolves.toBeUndefined();
  });

  it("returns undefined when the binding has no per-user vendor", async () => {
    await expect(resolveSessionActor(
        "alice", 1, null, undefined, undefined, async () => VERIFIER))
        .resolves.toBeUndefined();
  });

  it("returns observerId without a verifier when no account was chosen", async () => {
    await expect(resolveSessionActor(
        "bob", 1, "test", { observerId: "obs-1", accountChoices: {} }, undefined,
        async () => VERIFIER))
        .resolves.toEqual({ observerId: "obs-1" });
  });

  it("returns observerId without a verifier when the chosen account is gone", async () => {
    await expect(resolveSessionActor(
        "bob", 1, "test", { observerId: "obs-1", accountChoices: { 1: 7 } }, undefined,
        async () => null))
        .resolves.toEqual({ observerId: "obs-1" });
  });

  it("returns the collaborator's verifier for their chosen account", async () => {
    await expect(resolveSessionActor(
        "bob", 1, "test", { observerId: "obs-1", accountChoices: { 1: 7 } }, undefined,
        async (profileId, accountId, vendorId) => {
          expect({ profileId, accountId, vendorId }).toEqual(
              { profileId: "bob", accountId: 7, vendorId: "test" });
          return VERIFIER;
        }))
        .resolves.toEqual({ observerId: "obs-1", verifier: VERIFIER });
  });

  it("uses the owner's stored choices when there is no observer record", async () => {
    await expect(resolveSessionActor(
        "alice", 2, "test", undefined, { accountChoices: { 2: 9 } },
        async (profileId, accountId, vendorId) => {
          expect({ profileId, accountId, vendorId }).toEqual(
              { profileId: "alice", accountId: 9, vendorId: "test" });
          return VERIFIER;
        }))
        .resolves.toEqual({ verifier: VERIFIER });
  });
});

// What ensureOwnerActorAccounts does with the owner's stored account choices: a choice that names an
// account the owner has since disconnected is dropped and re-chosen, so a reconnect actually
// repairs the binding instead of leaving every session with no verifier.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// observer-verification-failure.test.ts); the owner's User DO is the only fake.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

function seedGatekeepers(impl: any, ids: number[] = [1, 2]): void {
  for (let id of ids) {
    impl.storage.gatekeepers.put({
      id,
      resourceTitle: `Connection ${id}`,
      class: {} as any,
      creationSpec: {
        type: "gatekeeper",
        vendorId: "testvendor",
        resourceUrl: `https://example.com/${id}`,
        typeUrlPattern: "https://*",
      },
    });
  }
}

// The owner's User DO, answering only the one question this path asks it.
function ownerWithAccounts(ids: number[]) {
  let calls = 0;
  const owner = {
    listAccountIdsForVendor: async () => { calls++; return ids; },
  } as any;
  return { owner, calls: () => calls };
}

describe("ensureOwnerActorAccounts", () => {
  it("drops a choice whose account is gone and picks the one account that remains", async () => {
    let stub = env.TEST_OVERSEER.getByName("owner-actor-stale-choice");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.ownerProfileId = "owner";
      seedGatekeepers(impl);
      // A previous open chose account 99 for both bindings. The owner has since disconnected 99
      // and connected 108 -- the live 2026-09-22 sequence.
      impl.storage.actorAccounts.put({ profileId: "owner", accountChoices: { 1: 99, 2: 99 } });
      let { owner, calls } = ownerWithAccounts([108]);

      await impl.ensureOwnerActorAccounts("owner", owner);

      expect(impl.storage.actorAccounts.get("owner").accountChoices).toEqual({ 1: 108, 2: 108 });
      // One vendor, one User DO round trip, however many bindings share it.
      expect(calls()).toBe(1);
    });
  });

  it("keeps a choice whose account still exists", async () => {
    let stub = env.TEST_OVERSEER.getByName("owner-actor-live-choice");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.ownerProfileId = "owner";
      seedGatekeepers(impl);
      // Two accounts for the vendor; the owner chose 50 for binding 1 and 60 for binding 2.
      impl.storage.actorAccounts.put({ profileId: "owner", accountChoices: { 1: 50, 2: 60 } });
      let { owner } = ownerWithAccounts([50, 60]);

      await impl.ensureOwnerActorAccounts("owner", owner);

      expect(impl.storage.actorAccounts.get("owner").accountChoices).toEqual({ 1: 50, 2: 60 });
    });
  });

  it("asks the client again when a stale choice has more than one replacement", async () => {
    let stub = env.TEST_OVERSEER.getByName("owner-actor-stale-ambiguous");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.ownerProfileId = "owner";
      seedGatekeepers(impl, [1]);
      impl.storage.actorAccounts.put({ profileId: "owner", accountChoices: { 1: 99 } });
      let { owner } = ownerWithAccounts([50, 60]);
      let asked: number[] = [];
      let configureCb = { configure: async (needs: {gatekeeperId: number}[]) => {
        asked.push(...needs.map(need => need.gatekeeperId));
        return needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: 60 }));
      } } as any;

      await impl.ensureOwnerActorAccounts("owner", owner, configureCb);

      // The stale binding was re-presented as uncovered rather than left pointing at 99.
      expect(asked).toEqual([1]);
      expect(impl.storage.actorAccounts.get("owner").accountChoices).toEqual({ 1: 60 });
    });
  });

  it("leaves a stale choice unfilled, not stale, when there is no client to ask", async () => {
    let stub = env.TEST_OVERSEER.getByName("owner-actor-stale-headless");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.ownerProfileId = "owner";
      seedGatekeepers(impl, [1]);
      impl.storage.actorAccounts.put({ profileId: "owner", accountChoices: { 1: 99 } });
      let { owner } = ownerWithAccounts([50, 60]);

      await impl.ensureOwnerActorAccounts("owner", owner);

      // No choice at all is the honest state: the session gets no verifier and the gatekeeper
      // says so, instead of a verifier lookup against an account that no longer exists.
      expect(impl.storage.actorAccounts.get("owner").accountChoices).toEqual({});
    });
  });
});

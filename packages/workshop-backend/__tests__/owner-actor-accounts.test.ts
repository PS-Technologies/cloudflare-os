// What ensureOwnerActorAccounts does with the owner's stored account choices: a choice that names an
// account the owner has since disconnected is dropped and re-chosen, so a reconnect actually
// repairs the binding instead of leaving every session with no verifier.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// observer-verification-failure.test.ts); the owner's User DO is the only fake.

import { describe, expect, it, vi } from "vitest";
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

  it("preserves choices written while account lookup is suspended", async () => {
    let stub = env.TEST_OVERSEER.getByName("owner-actor-interleaved-choice");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.ownerProfileId = "owner";
      seedGatekeepers(impl);
      impl.storage.actorAccounts.put({ profileId: "owner", accountChoices: { 1: 99, 2: 50 } });
      let owner = {
        listAccountIdsForVendor: async () => {
          impl.storage.actorAccounts.put({
            profileId: "owner",
            accountChoices: { 1: 77, 2: 50, 3: 42 },
          });
          return [50, 108];
        },
      } as any;

      await impl.ensureOwnerActorAccounts("owner", owner);

      expect(impl.storage.actorAccounts.get("owner").accountChoices).toEqual({
        1: 77,
        2: 50,
        3: 42,
      });
    });
  });

  it("skips persistence when account choices are unchanged", async () => {
    let stub = env.TEST_OVERSEER.getByName("owner-actor-unchanged-choice");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.ownerProfileId = "owner";
      seedGatekeepers(impl);
      impl.storage.actorAccounts.put({ profileId: "owner", accountChoices: { 1: 50, 2: 60 } });
      let put = vi.spyOn(impl.storage.actorAccounts, "put");
      let { owner } = ownerWithAccounts([50, 60]);

      await impl.ensureOwnerActorAccounts("owner", owner);

      expect(put).not.toHaveBeenCalled();
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


it.each([
  ["one own account", [7], 7, true],
  ["ambiguous own accounts", [7, 8], undefined, true],
  ["one own account after restart", [7], 7, false],
  ["ambiguous own accounts after restart", [7, 8], undefined, false],
])(
    "resolves an owner session for a connection added after open with %s", async (_label, ids, chosen, cached) => {
  await runInDurableObject(env.TEST_OVERSEER.getByName(`owner-new-connection-${ids.length}-${cached}`),
      async (instance: OverseerDurableObject) => {
    const impl = (instance as unknown as {impl: any}).impl;
    impl.ownerProfileId = cached ? "owner" : undefined;
    impl.ownerId = "owner";
    seedGatekeepers(impl, [1]);
    const verifier = {ownAccount: true};
    const lookedUp: number[] = [];
    impl.users = {
      idFromName: (profile: string) => { expect(profile).toBe("owner"); return profile; },
      get: () => ({
        listAccountIdsForVendor: async () => ids,
        getVerifier: async (accountId: number) => { lookedUp.push(accountId); return verifier; },
      }),
    };
    const actor = await impl.resolveActorForSession(1, {from: "user", profileId: "owner"});
    expect(actor.verifier).toEqual(chosen === undefined ? undefined : verifier);
    expect(lookedUp).toEqual(chosen === undefined ? [] : [chosen]);
  });
});

it.each(["owner", "collaborator"])(
    "omits the %s actor only while a resource creation is pending", async profileId => {
  await runInDurableObject(env.TEST_OVERSEER.getByName(`pending-creation-actor-${profileId}`),
      async (instance: OverseerDurableObject) => {
    const impl = (instance as unknown as {impl: any}).impl;
    impl.ownerProfileId = "owner";
    seedGatekeepers(impl, [1]);
    const accountChoices = {1: 7};
    if (profileId === "owner") {
      impl.storage.actorAccounts.put({profileId, accountChoices});
    } else {
      impl.storage.observers.put({profileId, accountChoices, observerId: "observer-1"});
    }
    const creation = {
      id: 1, gatekeeperId: 1, type: "action", action: "create", state: "pending",
      caller: {from: "agent", chatId: 1}, createdAt: new Date(0),
      description: {title: "Create the resource", description: "Create", implementsRevert: false},
    };
    impl.storage.actions.put(creation);
    const verifier = {ownAccount: true};
    let userLookups = 0;
    impl.users = {
      idFromName: (profile: string) => { expect(profile).toBe(profileId); return profile; },
      get: () => {
        userLookups++;
        return {getVerifier: async (accountId: number) => {
          expect(accountId).toBe(7);
          return verifier;
        }};
      },
    };

    expect(await impl.resolveActorForSession(1, {from: "user", profileId})).toBeUndefined();
    expect(userLookups).toBe(0);

    creation.state = "approved";
    impl.storage.actions.put(creation);
    const actor = await impl.resolveActorForSession(1, {from: "user", profileId});
    expect(actor.verifier).toEqual(verifier);
    expect(userLookups).toBe(1);
  });
});

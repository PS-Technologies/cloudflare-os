// What resolveActorForSession tells a gatekeeper about where the person asked: the external message
// an agent turn answers, read off that message's waiting response target, and nothing once a
// person's later message in the chat has started a turn of its own (patch 0007, amended 2026-09-29).
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// owner-actor-accounts.test.ts). No account choice is stored, so no User DO is reached: the actor
// comes back named and without a verifier.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const KEY = "teams:a:1person:activity-1";

function seed(impl: any, delivery: "waiting" | "ready" | "delivered" = "waiting"): void {
  impl.storage.gatekeepers.put({
    id: 1,
    resourceTitle: "Connection 1",
    class: {} as any,
    creationSpec: {
      type: "gatekeeper",
      vendorId: "testvendor",
      resourceUrl: "https://example.com/1",
      typeUrlPattern: "https://*",
    },
  });
  userMessage(impl, 5, "Sign me in");
  let base = { idempotencyKey: KEY, chatId: 3, promptSequence: 5, createdAt: 0 };
  impl.storage.gadgetResponseDeliveries.put(
    delivery === "delivered" ? { ...base, status: "delivered", deliveredAt: 1 }
      : delivery === "ready" ? { ...base, status: "ready", chatGatewayRpcTarget: {}, responseText: "Done." }
      : { ...base, status: "waiting", chatGatewayRpcTarget: {} });
}

function userMessage(impl: any, sequence: number, message: string): void {
  impl.storage.chats.put({
    chatId: 3, sequence, timestamp: new Date(sequence), type: "message", message,
    author: { type: "user", id: "person@example.com", name: "Person" },
  });
}

async function withOverseer(name: string, body: (impl: any) => Promise<void>): Promise<void> {
  await runInDurableObject(env.TEST_OVERSEER.getByName(name),
      async (instance: OverseerDurableObject) => body((instance as unknown as { impl: any }).impl));
}

describe("resolveActorForSession: where the person asked", () => {
  it("names the external message the agent turn answers, and the person", async () => {
    await withOverseer("actor-origin-waiting", async impl => {
      seed(impl);
      await expect(impl.resolveActorForSession(
          1, { from: "agent", chatId: 3, profileId: "person@example.com" }))
          .resolves.toEqual({ profileId: "person@example.com", externalMessageKey: KEY });
    });
  });

  it("names none once a person's later message in the chat starts a turn of its own", async () => {
    await withOverseer("actor-origin-later-message", async impl => {
      seed(impl);
      // An agent reply in the same turn does not end it; a person's message does.
      impl.storage.chats.put({
        chatId: 3, sequence: 6, timestamp: new Date(6), type: "message", message: "Opened the page.",
        author: { type: "agent", id: "model", name: "Model" },
      });
      await expect(impl.resolveActorForSession(
          1, { from: "agent", chatId: 3, profileId: "person@example.com" }))
          .resolves.toHaveProperty("externalMessageKey", KEY);
      userMessage(impl, 7, "Typed in the Workshop");
      await expect(impl.resolveActorForSession(
          1, { from: "agent", chatId: 3, profileId: "person@example.com" }))
          .resolves.toEqual({ profileId: "person@example.com" });
    });
  });

  it("names none once the reply is owed no longer, in another chat, or off an agent turn", async () => {
    await withOverseer("actor-origin-ready", async impl => {
      seed(impl, "ready");
      await expect(impl.resolveActorForSession(
          1, { from: "agent", chatId: 3, profileId: "person@example.com" }))
          .resolves.not.toHaveProperty("externalMessageKey");
    });
    await withOverseer("actor-origin-delivered", async impl => {
      seed(impl, "delivered");
      await expect(impl.resolveActorForSession(
          1, { from: "agent", chatId: 3, profileId: "person@example.com" }))
          .resolves.not.toHaveProperty("externalMessageKey");
    });
    await withOverseer("actor-origin-elsewhere", async impl => {
      seed(impl);
      await expect(impl.resolveActorForSession(
          1, { from: "agent", chatId: 4, profileId: "person@example.com" }))
          .resolves.not.toHaveProperty("externalMessageKey");
      await expect(impl.resolveActorForSession(
          1, { from: "gadget", chatId: 3, gadgetId: 2, profileId: "person@example.com" }))
          .resolves.toEqual({ profileId: "person@example.com" });
      await expect(impl.resolveActorForSession(
          1, { from: "user", chatId: 3, profileId: "person@example.com" }))
          .resolves.toEqual({ profileId: "person@example.com" });
      // A callback turn names no person, so it has no actor to carry the key.
      await expect(impl.resolveActorForSession(1, { from: "agent", chatId: 3 }))
          .resolves.toBeUndefined();
    });
  });
});

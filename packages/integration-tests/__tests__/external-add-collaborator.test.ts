// Tests for ExternalMessageGateway.addCollaborator (addExternalCollaborator in overseer.ts): an
// authenticated channel -- Teams ingress auto-admit -- grants Build to a person on a workspace it
// owns, and the grant is attributed to the owner. That attribution must not carry the grant past
// the owner-invites-only latch, which exists so that only the owner chooses who is added.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, CollaboratorInfo, PublicApi } from "@gadgets/workshop-shared/api";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  connect, listConnectedAccounts, nextUsernames, signUp, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

let harness: Harness;
let interceptor: NetworkInterceptor;

beforeAll(async () => {
  interceptor = new NetworkInterceptor();
  interceptor.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  const unmocked = interceptor.getUnmockedCalls();
  await harness?.server.close();
  interceptor.uninstall();
  interceptor.reset();
  expect(unmocked).toEqual([]);
});

async function withSession<T>(body: (api: RpcStub<PublicApi>) => Promise<T>): Promise<T> {
  const publicApi = connect(harness.url);
  try {
    return await body(publicApi);
  } finally {
    publicApi[Symbol.dispose]();
  }
}

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(a => a.vendorId === TEST_VENDOR_ID) ?? null;
  });
}

async function control<T>(path: string, body: object): Promise<T> {
  const res = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER, `http://gatekeeper-test.test/control/${path}`,
    { method: "POST", body: JSON.stringify(body) });
  if (res.status !== 200) throw new Error(`${path} failed with ${res.status}: ${await res.text()}`);
  return await res.json() as T;
}

/** Create an external workspace owned by `callerEmail` and return its web-API id. */
async function newExternalWorkspace(callerEmail: string, gadgetKey: string): Promise<string> {
  // No test user has an AI model, so the submission is refused after the workspace is claimed.
  await expect(control("submit-external-message", {
    callerEmail, gadgetKey, chatKey: `chat-${gadgetKey}`, messageKey: crypto.randomUUID(),
    gadgetTitle: gadgetKey, prompt: "hello",
  })).resolves.toMatchObject({ accepted: false, message: expect.stringMatching(/AI model/i) });
  return (await control<{ gadgetId: string }>("external-gadget-id", { gadgetKey })).gadgetId;
}

function admit(gadgetKey: string, username: string) {
  return control<{ collaborator?: CollaboratorInfo | null, error?: string }>(
      "add-external-collaborator", { gadgetKey, username });
}

describe("external addCollaborator", () => {
  it.concurrent("admits an existing account to a workspace that has not latched", async () => {
    await withSession(async publicApi => {
      const [alice, bob] = nextUsernames("alice", "bob");
      const aliceApi = await signUp(publicApi, alice);
      await signUp(publicApi, bob);
      const gadgetKey = `external-${crypto.randomUUID()}`;
      const gadgetId = await newExternalWorkspace(alice, gadgetKey);

      await expect(admit(gadgetKey, bob)).resolves.toMatchObject({
        collaborator: { role: "build" } });
      using overseer = await aliceApi.openGadget(gadgetId);
      expect((await overseer.listCollaborators()).map(c => c.role)).toEqual(["build"]);
    });
  });

  it.concurrent("refuses once an observation has set ownerInvitesOnly", async () => {
    await withSession(async publicApi => {
      const [alice, carol] = nextUsernames("alice", "carol");
      const aliceApi = await signUp(publicApi, alice);
      const aliceAccount = await provisionAccount(aliceApi);
      await signUp(publicApi, carol);
      const gadgetKey = `external-${crypto.randomUUID()}`;
      const gadgetId = await newExternalWorkspace(alice, gadgetKey);

      let gatekeeperId;
      {
        using overseer = await aliceApi.openGadget(gadgetId);
        const gatekeeper = await overseer.newGatekeeper(
            aliceAccount.id, "https://gadgets-test.example/things/owner-invites-only");
        if (!gatekeeper) throw new Error("Failed to create the test connection");
        gatekeeperId = await gatekeeper.getId();
      }

      // Reopened, as the owner's next page load would, so the session runs as the owner.
      using overseer = await aliceApi.openGadget(gadgetId);
      {
        const gatekeeper = await overseer.getGatekeeperById(gatekeeperId);
        using session = await gatekeeper.openSession() as RpcStub<TestSession>;
        // The latch alone, without containsRestrictedData: the older restricted-data refusal must
        // not be what stops this.
        await expect(session.readValue(false, true)).resolves.toBe(42);
      }

      const metadata = await overseer.getMetadata();
      expect(metadata.ownerInvitesOnly).toBe(true);
      expect(metadata.containsRestrictedData).not.toBe(true);

      await expect(admit(gadgetKey, carol)).resolves.toEqual({
        error: expect.stringMatching(/Only the workspace owner/) });
      expect(await overseer.listCollaborators()).toEqual([]);

      // The owner still adds people directly.
      await expect(overseer.addCollaborator(carol, "build")).resolves.toMatchObject({
        role: "build" });
    });
  });
});

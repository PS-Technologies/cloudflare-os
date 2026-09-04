// Binding sessions and gadget facet calls execute as the person using the workspace, not the
// person who created the connection. The fixture gatekeeper reports that person via whoAmI().
//
// Nothing is stubbed but the network. The real workshop-backend runs under wrangler with Worker
// Loader enabled so gadget server.js actually loads.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AiChatAuthorInfo, AiModelConfig, AuthenticatedApi, GadgetClient, Overseer, PublicApi,
} from "@gadgets/workshop-shared/api";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import {
  accountLabel, connect, listConnectedAccounts, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, signUp, stubFor, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";
import { scriptedChatCompletions } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

const MODEL_ID = "@cf/zai-org/glm-5.2";
const MODEL_PROFILE: AiChatAuthorInfo = { type: "agent", id: MODEL_ID, name: "Scripted model" };
const MODEL_CONFIG: AiModelConfig = {
  provider: "cloudflare",
  model: MODEL_ID,
  accountId: "test-account",
  apiToken: "test-token",
};

const GADGET_SERVER = `\
import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async whoAmI() {
    return this.env.TEST_THING.whoAmI();
  }
  async stashBinding() {
    this.stashed = this.env.TEST_THING;
    return this.stashed.whoAmI();
  }
  async replayStashed() {
    return this.stashed.whoAmI();
  }
}
`;

let harness: Harness;
let interceptor: NetworkInterceptor;
const agentModel = scriptedChatCompletions([
  {
    toolCall: {
      id: "who-am-i",
      name: "executeCode",
      arguments: {
        code: "export default async function(self, env) { console.log(await env.TEST_AMBIENT.whoAmI()); }",
      },
    },
  },
  { text: "Done." },
]);

beforeAll(async () => {
  interceptor = new NetworkInterceptor([agentModel.handler]);
  interceptor.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
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

function thingUrl(name: string): string {
  return `https://gadgets-test.example/things/${name}`;
}

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(a => a.vendorId === TEST_VENDOR_ID) ?? null;
  });
}

async function whoAmI(session: { whoAmI(): Promise<string> }): Promise<string> {
  return session.whoAmI();
}

type SharedWorkspace = {
  workspaceId: string;
  gadgetId: number;
  gatekeeperId: number;
  aliceApi: RpcStub<AuthenticatedApi>;
  aliceLabel: string;
  bobApi: RpcStub<AuthenticatedApi>;
  bobAccount: ConnectedAccount;
  bobLabel: string;
  bobShareKey?: string;
};

async function shareBoundGadget(
    publicApi: RpcStub<PublicApi>, thingName: string,
    bobAccess: "build" | "use" = "build"): Promise<SharedWorkspace> {
  const [alice, bob] = nextUsernames("alice", "bob");
  const aliceApi = await signUp(publicApi, alice);
  const bobApi = await signUp(publicApi, bob);
  const aliceAccount = await provisionAccount(aliceApi);
  const bobAccount = await provisionAccount(bobApi);

  const overseer = await aliceApi.newGadget();
  const bound = await overseer.newGatekeeper(aliceAccount.id, thingUrl(thingName));
  if (!bound) throw new Error("Failed to create the test connection");
  const gatekeeperId = await bound.getId();

  const chatId = await overseer.newChat("Seed the gadget server", null);
  const gadget = await overseer.createGadget("Actor gadget", chatId, "ACTOR_GADGET");
  const gadgetId = await gadget.getId();
  await gadget.bind("TEST_THING", gatekeeperId, chatId);

  const chat = (await overseer.listChats()).find(entry => entry.id === chatId);
  const generation = chat?.codeBase?.generation ?? 0;
  const revision = chat?.codeBase?.revision ?? 0;
  await overseer.submitCodeChange(chatId, {
    generation,
    revision,
    clientId: crypto.randomUUID(),
    seq: 1,
    change: { [gadgetId]: [["server.js", { set: GADGET_SERVER }]] },
  });
  const merged = await overseer.mergeChanges(chatId);
  if (merged.outcome !== "merged") {
    throw new Error(`Expected the gadget server to merge, got ${merged.outcome}`);
  }

  const { id: workspaceId } = await overseer.getMetadata();
  let bobShareKey: string | undefined;
  if (bobAccess === "use") {
    bobShareKey = (await overseer.createShareLink("use")).key;
  } else {
    const collaborator = await overseer.addCollaborator(bob, "build");
    if (!collaborator) throw new Error(`Failed to share the workspace with ${bob}`);
  }
  overseer[Symbol.dispose]();

  return {
    workspaceId,
    gadgetId,
    gatekeeperId,
    aliceApi,
    aliceLabel: accountLabel(aliceAccount),
    bobApi,
    bobAccount,
    bobLabel: accountLabel(bobAccount),
    bobShareKey,
  };
}

async function bobOpens(shared: SharedWorkspace): Promise<RpcStub<Overseer>> {
  const recorder =
      new ObserverConfigRecorder().alwaysChoose(shared.bobAccount.id, MAX_OBSERVER_PROMPTS);
  const callback = stubFor(recorder);
  try {
    return await shared.bobApi.openGadget(shared.workspaceId, shared.bobShareKey, callback);
  } finally {
    callback[Symbol.dispose]();
  }
}

async function aliceOpens(shared: SharedWorkspace): Promise<RpcStub<Overseer>> {
  return shared.aliceApi.openGadget(shared.workspaceId);
}

async function openSession(
    overseer: RpcStub<Overseer>, gatekeeperId: number): Promise<{ whoAmI(): Promise<string> }> {
  const client = await overseer.getGatekeeperById(gatekeeperId);
  return client.openSession();
}

async function connectGadget(
    overseer: RpcStub<Overseer>, gadgetId: number): Promise<RpcStub<GadgetClient> & {
      whoAmI(): Promise<string>;
      stashBinding(): Promise<string>;
      replayStashed(): Promise<string>;
    }> {
  const gadget = await overseer.getGadget(gadgetId);
  return gadget.connectToGadget() as Promise<RpcStub<GadgetClient> & {
    whoAmI(): Promise<string>;
    stashBinding(): Promise<string>;
    replayStashed(): Promise<string>;
  }>;
}

describe("session actor", () => {
  it.concurrent("opens a binding session as the person using it", async () => {
    await withSession(async publicApi => {
      const shared = await shareBoundGadget(publicApi, "binding");
      using aliceWorkspace = await aliceOpens(shared);
      using bobWorkspace = await bobOpens(shared);

      using aliceSession = await openSession(aliceWorkspace, shared.gatekeeperId);
      using bobSession = await openSession(bobWorkspace, shared.gatekeeperId);
      await expect(whoAmI(aliceSession)).resolves.toBe(shared.aliceLabel);
      await expect(whoAmI(bobSession)).resolves.toBe(shared.bobLabel);
    });
  });

  it.concurrent("refuses a binding session when the actor's account is gone", async () => {
    await withSession(async publicApi => {
      const shared = await shareBoundGadget(publicApi, "gone");
      using bobWorkspace = await bobOpens(shared);
      using live = await openSession(bobWorkspace, shared.gatekeeperId);
      await expect(whoAmI(live)).resolves.toBe(shared.bobLabel);

      await shared.bobApi.disconnectAccount(shared.bobAccount.id);
      using client = await bobWorkspace.getGatekeeperById(shared.gatekeeperId);
      // startSession throws, so the session stub itself rejects — don't pipeline whoAmI onto it.
      await expect(client.openSession()).rejects.toThrow(/reconnect/i);
    });
  });

  it.concurrent("runs gadget facet calls as the viewer, with no cross-talk", async () => {
    await withSession(async publicApi => {
      const shared = await shareBoundGadget(publicApi, "facet", "use");
      using aliceWorkspace = await aliceOpens(shared);
      using bobWorkspace = await bobOpens(shared);
      using aliceGadget = await connectGadget(aliceWorkspace, shared.gadgetId);
      using bobGadget = await connectGadget(bobWorkspace, shared.gadgetId);

      const seen: string[] = [];
      for (let i = 0; i < 20; i++) {
        const [alice, bob] = await Promise.all([
          aliceGadget.whoAmI(),
          bobGadget.whoAmI(),
        ]);
        seen.push(alice, bob);
      }
      expect(seen.filter(label => label === shared.aliceLabel)).toHaveLength(20);
      expect(seen.filter(label => label === shared.bobLabel)).toHaveLength(20);
    });
  });

  it.concurrent("refuses a binding stub stashed past the gadget call that created it", async () => {
    await withSession(async publicApi => {
      const shared = await shareBoundGadget(publicApi, "stash");
      using aliceWorkspace = await aliceOpens(shared);
      using gadget = await connectGadget(aliceWorkspace, shared.gadgetId);

      await expect(gadget.stashBinding()).resolves.toBe(shared.aliceLabel);
      await expect(gadget.replayStashed()).rejects.toThrow(/only valid for the gadget call/i);
    });
  });

  it("runs an agent executeCode turn as the person who sent the message", async () => {
    await withSession(async publicApi => {
      const shared = await shareBoundGadget(publicApi, "agent");
      await shared.bobApi.addModel(MODEL_PROFILE, MODEL_CONFIG);
      await shared.bobApi.setQuickModel(null);
      await shared.bobApi.setPreferredModel(MODEL_ID);
      await shared.bobApi.completeOnboarding();

      using bobWorkspace = await bobOpens(shared);
      const chatId = await bobWorkspace.newChat(
          "Who is the test ambient session running as?", MODEL_ID);
      const history = await waitFor("the scripted agent to return its final answer", async () => {
        const current = await bobWorkspace.getChatHistory(chatId);
        const error = current.messages.find(message => message.type === "error");
        if (error !== undefined) throw new Error(`The scripted agent failed: ${error.message}`);
        return current.messages.some(message =>
          message.type === "message" && message.author.type === "agent" &&
          message.message === "Done.") ? current : null;
      });
      expect(history.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "message",
          author: expect.objectContaining({ type: "agent" }),
          toolCalls: expect.arrayContaining([
            expect.objectContaining({
              toolName: "executeCode",
              output: expect.stringContaining(shared.bobLabel),
            }),
          ]),
        }),
      ]));
      expect(history.messages).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "message",
          toolCalls: expect.arrayContaining([
            expect.objectContaining({
              toolName: "executeCode",
              output: expect.stringContaining(shared.aliceLabel),
            }),
          ]),
        }),
      ]));
    });
  });
});

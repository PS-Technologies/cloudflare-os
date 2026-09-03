// Exercises the operate-only bit (see GadgetRecord.operateOnly in overseer.ts): a blueprint that
// declares it produces gadgets a chat agent may drive but not edit, whose facet never runs a
// chat-proposed version.
//
// Like chat-changes.test.ts, the Overseer parts run against the real OverseerImpl in workerd via
// the TEST_OVERSEER binding, reaching into `impl` because no public path can set these scenarios
// up: the flag only ever arrives from a blueprint.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import * as Y from "yjs";
import type { OverseerDurableObject } from "../src/overseer.js";
import { OPERATED_GADGET_EDIT_ERROR, gadgetFacetChatId } from "../src/overseer.js";
import { blueprintOperateOnly } from "../src/blueprint-archive.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

let doCounter = 0;
async function withOverseer(
    fn: (instance: any, impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`operated-gadgets-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await fn(instance, (instance as unknown as { impl: any }).impl);
  });
}

// A blueprint code archive: the doc's unnamed root map, filename -> Y.Text (see snapshotCode).
function archiveBytes(files: Record<string, string>): Uint8Array {
  let doc = new Y.Doc();
  let map = doc.getMap<Y.Text>();
  for (let [name, content] of Object.entries(files)) {
    let text = new Y.Text();
    map.set(name, text);
    text.insert(0, content);
  }
  return Y.encodeStateAsUpdateV2(doc);
}

const BLUEPRINT_ID = "bp-proposal";
const BLUEPRINT_FILES = { "server.js": "export default {}", "README.md": "# Proposal" };

// The KV/R2 surface fetchBlueprint reads, with no admin config (so the deployment applies no
// output override).
function fakeBlueprintEnv(realEnv: any, metadata: Record<string, unknown>) {
  return {
    ...realEnv,
    BLUEPRINTS: {
      async get(key: string) {
        if (key !== BLUEPRINT_ID) return null;   // includes the ".adminConfig" read
        return JSON.stringify({ metadata, ownerId: "owner-do" });
      },
    },
    BLUEPRINT_CONTENT: {
      async get() {
        return {
          body: new Response(archiveBytes(BLUEPRINT_FILES)).body!
              .pipeThrough(new CompressionStream("gzip")),
        };
      },
    },
  };
}

function blueprintMetadata(extra: Record<string, unknown> = {}) {
  return {
    title: "Principle Proposal",
    description: "",
    author: { type: "user", id: "owner@example.com", name: "Owner" },
    created: new Date(0),
    version: 1,
    lastUpdated: new Date(0),
    bindings: {},
    ...extra,
  };
}

// A user DO stand-in for the two calls initializeFromBlueprint makes on the owner.
function fakeUsers() {
  return {
    idFromString: (id: string) => id,
    idFromName: (name: string) => name,
    get: () => ({
      id: { toString: () => "owner-do" },
      whoami: async () => ({ id: "owner@example.com", name: "Owner" }),
      setGadgetLastActive: async () => {},
    }),
  };
}

describe("blueprintOperateOnly", () => {
  it("accepts only a literal true", () => {
    expect(blueprintOperateOnly({ operateOnly: true })).toBe(true);
  });

  it.each([
    ["absent", {}],
    ["false", { operateOnly: false }],
    ["the string \"true\"", { operateOnly: "true" }],
    ["1", { operateOnly: 1 }],
  ])("treats %s as an ordinary, editable gadget", (_label, metadata) => {
    expect(blueprintOperateOnly(metadata as { operateOnly?: unknown })).toBeUndefined();
  });
});

describe("createGadget", () => {
  it("stamps the blueprint's operate-only declaration on a chat-created gadget", async () => {
    await withOverseer(async (_instance, impl) => {
      let record = impl.createGadget("Proposal", "PROPOSAL", 7, undefined, true);
      expect(record.operateOnly).toBe(true);
      expect(record.pending).toEqual({ chatId: 7 });
      expect(impl.storage.gadgets.get(record.id).operateOnly).toBe(true);
    });
  });

  it("leaves a gadget built from scratch editable", async () => {
    await withOverseer(async (_instance, impl) => {
      let record = impl.createGadget("Scratch", "SCRATCH", 7);
      expect(record.operateOnly).toBeUndefined();
      expect(impl.storage.gadgets.get(record.id).operateOnly).toBeUndefined();
    });
  });
});

describe("fetchBlueprint (the chat createGadget path)", () => {
  it("reports a blueprint's operate-only declaration and tells the agent what to do instead",
      async () => {
    await withOverseer(async (_instance, impl) => {
      impl.env = fakeBlueprintEnv(impl.env, blueprintMetadata({ operateOnly: true }));
      let blueprint = await impl.fetchBlueprint(BLUEPRINT_ID);
      expect(blueprint.operateOnly).toBe(true);
      expect(blueprint.notes).toContain("operated, not edited here");
      expect(Object.keys(blueprint.files).toSorted()).toEqual(["README.md", "server.js"]);
    });
  });

  it("reports nothing for an ordinary blueprint", async () => {
    await withOverseer(async (_instance, impl) => {
      impl.env = fakeBlueprintEnv(impl.env, blueprintMetadata());
      let blueprint = await impl.fetchBlueprint(BLUEPRINT_ID);
      expect(blueprint.operateOnly).toBeUndefined();
      expect(blueprint.notes).not.toContain("operated, not edited here");
    });
  });
});

describe("initializeFromBlueprint (the landing-page Create path)", () => {
  it("stamps the flag on the workspace's gadget", async () => {
    await withOverseer(async (instance, impl) => {
      impl.ownerId = "owner-do";
      impl.users = fakeUsers();
      await instance.initializeFromBlueprint(
          archiveBytes(BLUEPRINT_FILES), "Principle Proposal", undefined, true);
      let record = impl.storage.gadgets.get(impl.defaultGadgetId);
      expect(record.operateOnly).toBe(true);
      expect(record.commitId).toBeTypeOf("string");
    });
  });

  it("leaves an ordinary blueprint's gadget editable", async () => {
    await withOverseer(async (instance, impl) => {
      impl.ownerId = "owner-do";
      impl.users = fakeUsers();
      await instance.initializeFromBlueprint(
          archiveBytes(BLUEPRINT_FILES), "Ordinary App", undefined, undefined);
      expect(impl.storage.gadgets.get(impl.defaultGadgetId).operateOnly).toBeUndefined();
    });
  });
});

describe("assertGadgetEditable (what writeFile / editFile call)", () => {
  it("refuses an operated gadget, naming the alternative", async () => {
    await withOverseer(async (_instance, impl) => {
      let record = impl.createGadget("Proposal", "PROPOSAL", 7, undefined, true);
      expect(() => impl.assertGadgetEditable(record.id)).toThrow(OPERATED_GADGET_EDIT_ERROR);
      expect(OPERATED_GADGET_EDIT_ERROR).toContain("RPC methods");
    });
  });

  it("allows an ordinary gadget", async () => {
    await withOverseer(async (_instance, impl) => {
      let record = impl.createGadget("Scratch", "SCRATCH", 7);
      expect(() => impl.assertGadgetEditable(record.id)).not.toThrow();
    });
  });
});

describe("gadgetFacetChatId", () => {
  const HEAD = { commitId: "a".repeat(40) };
  const OPERATED = { commitId: "a".repeat(40), operateOnly: true as const };
  const PROPOSING = { hasProposedChanges: true };

  it("runs the main version outside any chat", () => {
    expect(gadgetFacetChatId(HEAD, undefined, undefined)).toBeUndefined();
    expect(gadgetFacetChatId(OPERATED, undefined, undefined)).toBeUndefined();
  });

  it("runs an ordinary gadget's chat-proposed version", () => {
    expect(gadgetFacetChatId(HEAD, 3, PROPOSING)).toBe(3);
  });

  it("runs the main version for a chat with no proposed changes", () => {
    expect(gadgetFacetChatId(HEAD, 3, { hasProposedChanges: false })).toBeUndefined();
    expect(gadgetFacetChatId(HEAD, 3, undefined)).toBeUndefined();
  });

  it("ignores the chat for an operated gadget, proposed changes or not", () => {
    expect(gadgetFacetChatId(OPERATED, 3, PROPOSING)).toBeUndefined();
    expect(gadgetFacetChatId(OPERATED, 9, PROPOSING)).toBeUndefined();
  });

  it("still uses the creating chat for an operated gadget with no head yet", () => {
    // A pending gadget's files exist only in its creating chat's proposed changes.
    expect(gadgetFacetChatId({ operateOnly: true }, 3, PROPOSING)).toBe(3);
  });

  describe("a pending operated gadget (no head, created in chat 3)", () => {
    // Live, 2026-09-03: the gadget spawned a specialist the moment it was created. The
    // specialist's chat had nothing proposed, so it resolved to main, which does not exist yet,
    // and every call failed with "Gadget 9 has no server.js to load (files: 0)" until Accept.
    const PENDING_OPERATED = { operateOnly: true as const, pending: { chatId: 3 } };

    it("resolves the creating chat itself to its own version", () => {
      expect(gadgetFacetChatId(PENDING_OPERATED, 3, PROPOSING)).toBe(3);
    });

    it("resolves a caller outside any chat to the creating chat", () => {
      expect(gadgetFacetChatId(PENDING_OPERATED, undefined, undefined)).toBe(3);
    });

    it("resolves a caller in another chat to the creating chat, proposed changes or not", () => {
      expect(gadgetFacetChatId(PENDING_OPERATED, 9, undefined)).toBe(3);
      expect(gadgetFacetChatId(PENDING_OPERATED, 9, { hasProposedChanges: false })).toBe(3);
      expect(gadgetFacetChatId(PENDING_OPERATED, 9, PROPOSING)).toBe(3);
    });

    it("goes back to main once the creation is accepted", () => {
      // Accept writes the head and clears `pending` in one step; a record with both (a head and
      // a lingering pending stamp) is main too, since the head is what a permanent gadget runs.
      expect(gadgetFacetChatId({ operateOnly: true, commitId: "a".repeat(40) }, 9, PROPOSING))
          .toBeUndefined();
      expect(gadgetFacetChatId({ ...PENDING_OPERATED, commitId: "a".repeat(40) }, undefined,
                               undefined)).toBeUndefined();
    });
  });

  it("leaves a pending ordinary gadget on the old per-caller rule", () => {
    const PENDING = { pending: { chatId: 3 } };
    expect(gadgetFacetChatId(PENDING, undefined, undefined)).toBeUndefined();
    expect(gadgetFacetChatId(PENDING, 3, PROPOSING)).toBe(3);
    expect(gadgetFacetChatId(PENDING, 9, PROPOSING)).toBe(9);
    expect(gadgetFacetChatId(PENDING, 9, { hasProposedChanges: false })).toBeUndefined();
  });
});

describe("getGadgetFacetFetcher", () => {
  // Callers alternate exactly as they did live: the app view (no chat), the room agent's chat,
  // then a spawned specialist calling back through the app view again.
  const CALLERS: (number | undefined)[] = [1, undefined, 1, undefined];

  async function countAborts(operateOnly: boolean, record: Record<string, unknown> =
      { commitId: "a".repeat(40) }, callers: (number | undefined)[] = CALLERS): Promise<number> {
    let aborts: string[] = [];
    await withOverseer(async (_instance, impl) => {
      impl.storage.gadgets.put({
        id: 1, title: "Proposal", created: new Date(0), bindingName: "PROPOSAL",
        bindings: {}, ...record,
        ...(operateOnly ? { operateOnly: true } : {}),
      });
      impl.storage.chatMeta.put({
        id: 1, title: "Chat", started: new Date(0), lastActive: new Date(0),
        hasProposedChanges: true,
      });

      // A facet stand-in: `get` never runs its factory, so no gadget worker is loaded, and
      // `abort` just records. Restored below so nothing else in the DO sees the swap.
      let realCtx = impl.ctx;
      impl.ctx = {
        id: realCtx.id,
        exports: realCtx.exports,
        storage: realCtx.storage,
        facets: {
          abort(_name: string, err: Error) { aborts.push(err.message); },
          get() { return {}; },
        },
      };
      try {
        for (let chatId of callers) impl.getGadgetFacetFetcher(1, chatId);
      } finally {
        impl.ctx = realCtx;
      }
    });
    return aborts.length;
  }

  it("restarts an ordinary gadget's facet on every caller switch", async () => {
    // The live failure: four alternating callers, four aborts, every in-flight RPC killed.
    expect(await countAborts(false)).toBe(4);
  });

  it("never restarts an operated gadget's facet", async () => {
    // One defensive reset on first sight (the facet may be running from before this Overseer
    // started), then nothing: every caller resolves to the same main version.
    expect(await countAborts(true)).toBe(1);
  });

  it("never restarts a pending operated gadget's facet either", async () => {
    // The creating chat, the app view, a spawned specialist's chat (nothing proposed there, not
    // even a chat record yet), and the app view again: every caller resolves to the creating
    // chat's version, so the one defensive reset is all there is. An ordinary pending gadget
    // still swaps to main (which has no files) for the app view and stays there.
    const PENDING = { pending: { chatId: 1 } };
    const CALLERS_WITH_SPECIALIST = [1, undefined, 9, undefined];
    expect(await countAborts(true, PENDING, CALLERS_WITH_SPECIALIST)).toBe(1);
    expect(await countAborts(false, PENDING, CALLERS_WITH_SPECIALIST)).toBe(2);
  });
});

// LOADER runs the callback and hands back its config, so the assembled modules are visible.
async function loadModules(impl: any, gadgetId: number, chatId?: number)
    : Promise<Record<string, string>> {
  let realEnv = impl.env;
  impl.env = {
    ...realEnv,
    LOADER: { get: (_key: string, load: () => Promise<{ modules: Record<string, string> }>) => load() },
  };
  try {
    return (await impl.loadGadgetWorker(gadgetId, chatId)).modules;
  } finally {
    impl.env = realEnv;
  }
}

describe("loadGadgetWorker", () => {
  // The loader caches whatever the load callback returns under the code-version key, so a load
  // that came up with no server.js stayed dead until a binding rename moved the key (live,
  // 2026-09-03). The callback must fail instead of handing the loader an empty worker.
  async function loadWith(files: Record<string, string>): Promise<Record<string, string>> {
    let modules: Record<string, string> | undefined;
    await withOverseer(async (_instance, impl) => {
      impl.storage.gadgets.put({
        id: 1, title: "Proposal", created: new Date(0), bindingName: "PROPOSAL",
        bindings: {}, commitId: "a".repeat(40),
      });
      let realGitStore = impl.gitStore;
      // gitStore serves the files.
      impl.gitStore = { readCommitFiles: async () => new Map(Object.entries(files)) };
      try {
        modules = await loadModules(impl, 1);
      } finally {
        impl.gitStore = realGitStore;
      }
    });
    return modules!;
  }

  it("loads a pending operated gadget from its creating chat for a caller in another chat",
      async () => {
    // The chat createGadget path end to end: the record is minted mid-step, and the blueprint's
    // files reach storage through the step barrier, which appends the rows and materializes them
    // into the step's "changes" message in one transaction. So once the step is over, the
    // as-of-next-sequence chat content the load reads already holds the files, with no
    // materialize step of its own (which would be refused mid-turn anyway).
    await withOverseer(async (_instance, impl) => {
      impl.storage.chatMeta.put(
          { id: 3, title: "Room", started: new Date(0), lastActive: new Date(0) });
      impl.storage.chatMeta.put(
          { id: 9, title: "Specialist", started: new Date(1), lastActive: new Date(1) });
      let created = impl.createGadget("Proposal", "PROPOSAL", 3, undefined, true);
      expect(await impl.commitAgentStep(3, { type: "agent", id: "some-model", name: "Agent" },
          [{ type: "message", message: "made it" }], {
        changes: [{ change: { [created.id]: [
          ["server.js", { set: "export default {}" }], ["README.md", { set: "#" }]] } }],
        createdGadgets: [{ gadgetId: created.id, title: "Proposal", bindingName: "PROPOSAL" }],
        addedBindings: [],
      })).toBe(true);

      let record = impl.storage.gadgets.get(created.id);
      expect(record.commitId).toBeUndefined();
      expect(gadgetFacetChatId(record, 9, impl.storage.chatMeta.get(9))).toBe(3);
      expect(gadgetFacetChatId(record, undefined, undefined)).toBe(3);

      // What the facet would load for the specialist (and the app view): the creating chat's
      // version, with the files in it.
      expect(await loadModules(impl, created.id, 3)).toEqual({ "server.js": "export default {}" });
      // What it loaded before this rule: main, which a pending gadget does not have.
      await expect(loadModules(impl, created.id, undefined)).rejects.toThrow(
          `Gadget ${created.id} has no server.js to load (files: 0)`);
    });
  });

  it("refuses to hand the loader a worker with no server.js", async () => {
    await expect(loadWith({ "README.md": "# Proposal", "client.js": "" })).rejects.toThrow(
        "Gadget 1 has no server.js to load (files: 2); refusing to cache an empty load.");
  });

  it("loads the .js modules when server.js is present", async () => {
    expect(await loadWith({ "server.js": "export default {}", "client.js": "", "README.md": "#" }))
        .toEqual({ "server.js": "export default {}", "client.js": "" });
  });
});

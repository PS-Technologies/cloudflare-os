// A republish between fetching code and wiring must not combine two blueprint releases.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import * as Y from "yjs";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

describe("blueprint release wiring", () => {
  it("uses the fetched release's bindings when the blueprint is republished before wiring", async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName("blueprint-wiring-republish"),
        async (instance: OverseerDurableObject) => {
      const impl = (instance as unknown as {impl: any}).impl;
      const binding = (resourceUrl: string) => ({
        type: "gatekeeper", title: "Resource", gatekeeperName: "testvendor",
        typeUrlPattern: "https://example.com/*", resourceUrl,
      });
      let metadata = {
        title: "Bound app", description: "", author: {type: "user", id: "owner", name: "Owner"},
        created: new Date(0), lastUpdated: new Date(0), version: 1,
        bindings: {RESOURCE: binding("https://example.com/release-one")},
      };
      const doc = new Y.Doc();
      doc.getMap().set("server.js", new Y.Text("export class Gadget {}"));
      const bytes = Y.encodeStateAsUpdateV2(doc);
      impl.env = {
        ...impl.env,
        BLUEPRINTS: {get: async (key: string) => key === "blueprint-id"
            ? JSON.stringify({metadata, ownerId: "owner-do"}) : null},
        BLUEPRINT_CONTENT: {get: async () => ({body: new Response(bytes).body!
            .pipeThrough(new CompressionStream("gzip"))})},
      };
      let requested: string[] = [];
      impl.users = {
        idFromName: (id: string) => id,
        get: () => ({
          id: {toString: () => "owner-do"},
          listModels: async () => [],
          listConnectedAccountsSnapshot: async () => [{
            id: 1, vendorId: "testvendor", credentialsValid: true,
            supportedResources: [{urlPattern: "https://example.com/*"}],
          }],
          getGatekeeperClassFor: async (_accountId: number, resourceUrl: string) => {
            requested.push(resourceUrl);
            return {class: {}, vendorId: "testvendor", typeUrlPattern: "https://example.com/*"};
          },
        }),
      };
      impl.addGatekeeper = async () => {
        impl.storage.gatekeepers.put({id: 77, class: {}});
        return {getId: async () => 77};
      };
      const blueprint = await impl.fetchBlueprint("blueprint-id");
      metadata = {...metadata, version: 2,
          bindings: {RESOURCE: binding("https://example.com/release-two")}};
      const gadget = impl.createGadget("Bound app", "APP", 1, blueprint);
      const result = await impl.wireBlueprintBindings(gadget.id, "blueprint-id",
          {type: "user", id: "owner", name: "Owner"}, 1, blueprint.bindings);
      expect(requested).toEqual(["https://example.com/release-one"]);
      expect(result.addedBindings).toEqual([{name: "RESOURCE", target: 77}]);
      expect(blueprint.merge.version).toBe(1);
      expect(blueprint.files["server.js"]).toBe("export class Gadget {}");
    });
  });
});

import { describe, expect, it } from "vitest";
import type { AgentSpawnerConfig, BlueprintBinding, WorkpieceId } from "@gadgets/workshop-shared/api";
import {
  applyBlueprintWiring,
  findMatchingAccounts,
  findSuggestedModelId,
  NO_SUGGESTION_REASON,
  noConnectedAccountReason,
  suggestedModelMissingReason,
  type CatalogAccount,
  type CatalogModel,
  type WiringApplier,
} from "../src/blueprint-wiring.js";

const MODELS: CatalogModel[] = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "anthropic/claude-opus-4", name: "Claude Opus 4" },
  { id: "openai:gpt-5", name: "GPT 5" },
  { id: "@cf/zai-org/glm-5.3-flash", name: "GLM 5.3 Flash" },
];

describe("findSuggestedModelId", () => {
  it("matches an exact model id", () => {
    expect(findSuggestedModelId({ provider: "anthropic", modelName: "claude-sonnet-5" }, MODELS))
        .toBe("claude-sonnet-5");
  });

  it("matches an exact model name", () => {
    expect(findSuggestedModelId({ provider: "anthropic", modelName: "Claude Sonnet 5" }, MODELS))
        .toBe("claude-sonnet-5");
  });

  it("matches provider/modelName as an id", () => {
    expect(findSuggestedModelId({ provider: "anthropic", modelName: "claude-opus-4" }, MODELS))
        .toBe("anthropic/claude-opus-4");
  });

  it("matches provider:modelName as an id", () => {
    expect(findSuggestedModelId({ provider: "openai", modelName: "gpt-5" }, MODELS))
        .toBe("openai:gpt-5");
  });

  it("falls back to a single provider-scoped substring match", () => {
    expect(findSuggestedModelId({ provider: "zai-org", modelName: "glm-5.3-flash" }, MODELS))
        .toBe("@cf/zai-org/glm-5.3-flash");
  });

  it("returns null when the provider-scoped match is ambiguous", () => {
    let models: CatalogModel[] = [
      { id: "p/a-one", name: "A One" },
      { id: "p/a-two", name: "A Two" },
    ];
    expect(findSuggestedModelId({ provider: "p", modelName: "a" }, models)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(findSuggestedModelId({ provider: "missing", modelName: "nope" }, MODELS)).toBeNull();
  });
});

const ACCOUNTS: CatalogAccount[] = [
  {
    id: 1, vendorId: "work_fabric", credentialsValid: true,
    supportedResources: [{ urlPattern: "proposal://workspace" }],
  },
  {
    id: 2, vendorId: "GitHub", credentialsValid: true,
    supportedResources: [{ urlPattern: "https://github.com/*" }],
  },
  {
    id: 3, vendorId: "github", credentialsValid: false,
    supportedResources: [{ urlPattern: "https://github.com/*" }],
  },
  {
    id: 4, vendorId: "slack", credentialsValid: true,
    supportedResources: [{ urlPattern: "https://slack.com/*" }],
  },
];

describe("findMatchingAccounts", () => {
  const fabric = { gatekeeperName: "work_fabric", typeUrlPattern: "proposal://workspace" };

  it("matches vendor case-insensitively", () => {
    expect(findMatchingAccounts(
        { gatekeeperName: "WORK_FABRIC", typeUrlPattern: "proposal://workspace" }, ACCOUNTS)
        .map(a => a.id)).toEqual([1]);
  });

  it("requires credentialsValid", () => {
    expect(findMatchingAccounts(
        { gatekeeperName: "github", typeUrlPattern: "https://github.com/*" }, ACCOUNTS)
        .map(a => a.id)).toEqual([2]);
  });

  it("requires urlPattern equality", () => {
    expect(findMatchingAccounts(
        { gatekeeperName: "work_fabric", typeUrlPattern: "https://example.com" }, ACCOUNTS))
        .toEqual([]);
  });

  it("returns every match so the caller can enforce the exactly-one rule", () => {
    let two: CatalogAccount[] = [
      ...ACCOUNTS,
      {
        id: 9, vendorId: "work_fabric", credentialsValid: true,
        supportedResources: [{ urlPattern: "proposal://workspace" }],
      },
    ];
    expect(findMatchingAccounts(fabric, two).map(a => a.id)).toEqual([1, 9]);
  });
});

function stubApplier() {
  let nextId = 100;
  let created: { kind: string; arg: unknown; id: WorkpieceId }[] = [];
  let binds: { name: string; target: WorkpieceId }[] = [];
  let spawners: AgentSpawnerConfig[] = [];
  let applier: WiringApplier = {
    async createGatekeeper(accountId, resourceUrl) {
      let id = nextId++;
      created.push({ kind: "gatekeeper", arg: { accountId, resourceUrl }, id });
      return id;
    },
    async createAiModel(modelId) {
      let id = nextId++;
      created.push({ kind: "aiModel", arg: { modelId }, id });
      return id;
    },
    async createAgentSpawner(config) {
      let id = nextId++;
      created.push({ kind: "agentSpawner", arg: config, id });
      spawners.push(config);
      return id;
    },
    bind(name, target) { binds.push({ name, target }); },
  };
  return { applier, created, binds, spawners };
}

const FOUR_BINDING_BLUEPRINT: Record<string, BlueprintBinding> = {
  FABRIC: {
    type: "gatekeeper",
    title: "Proposal workspace",
    description: "",
    gatekeeperName: "work_fabric",
    typeUrlPattern: "proposal://workspace",
    resourceUrl: "proposal://workspace",
  },
  PROPOSAL_AGENT: {
    type: "agentSpawner",
    title: "Proposal specialist",
    description: "",
    suggestedModel: { provider: "zai-org", modelName: "glm-5.3-flash" },
    env: { GADGET: { type: "gadget" } },
  },
  PROPOSAL_EVALUATOR: {
    type: "agentSpawner",
    title: "Independent evaluator",
    description: "",
    suggestedModel: null,
    env: { GADGET: { type: "gadget" } },
  },
  OTHER: {
    type: "gatekeeper",
    title: "Somewhere else",
    description: "",
    gatekeeperName: "jira",
    typeUrlPattern: "https://jira.example.com/*",
    resourceUrl: "https://jira.example.com/browse/X",
  },
};

describe("applyBlueprintWiring", () => {
  it("wires the first three rows of a four-binding blueprint and reports the fourth unresolved",
      async () => {
    let { applier, created, binds, spawners } = stubApplier();
    let gadgetId = 7;
    let { report, addedBindings } = await applyBlueprintWiring(
        gadgetId, FOUR_BINDING_BLUEPRINT, MODELS, ACCOUNTS, applier);

    expect(created.map(c => c.kind)).toEqual(["gatekeeper", "agentSpawner", "agentSpawner"]);
    expect(binds.map(b => b.name)).toEqual(["FABRIC", "PROPOSAL_AGENT", "PROPOSAL_EVALUATOR"]);
    expect(addedBindings.map(b => b.name)).toEqual(["FABRIC", "PROPOSAL_AGENT", "PROPOSAL_EVALUATOR"]);
    expect(spawners[0].displayName).toBe("Proposal specialist");
    expect(spawners[0].modelId).toBe("@cf/zai-org/glm-5.3-flash");
    expect(spawners[0].env).toEqual({ GADGET: gadgetId });
    expect(spawners[1].modelId).toBeNull();
    expect(report.wired.map(r => r.name)).toEqual(
        ["FABRIC", "PROPOSAL_AGENT", "PROPOSAL_EVALUATOR"]);
    expect(report.unresolved).toEqual([{
      name: "OTHER",
      type: "gatekeeper",
      reason: noConnectedAccountReason("jira", "https://jira.example.com/*"),
    }]);
  });

  it("creates a second set of gatekeepers if applied again — replay must not re-run it",
      async () => {
    let { applier, created } = stubApplier();
    await applyBlueprintWiring(7, FOUR_BINDING_BLUEPRINT, MODELS, ACCOUNTS, applier);
    await applyBlueprintWiring(7, FOUR_BINDING_BLUEPRINT, MODELS, ACCOUNTS, applier);
    expect(created.filter(c => c.kind === "gatekeeper")).toHaveLength(2);
    expect(created.filter(c => c.kind === "agentSpawner")).toHaveLength(4);
  });

  it("does not normalise a vendor-scheme resourceUrl", async () => {
    let { applier, created } = stubApplier();
    await applyBlueprintWiring(1, {
      FABRIC: FOUR_BINDING_BLUEPRINT.FABRIC,
    }, MODELS, ACCOUNTS, applier);
    expect(created[0].arg).toEqual({ accountId: 1, resourceUrl: "proposal://workspace" });
  });

  it("skips binding a spawnerOnly row into the gadget", async () => {
    let { applier, binds } = stubApplier();
    let { report } = await applyBlueprintWiring(1, {
      HIDDEN: { ...FOUR_BINDING_BLUEPRINT.FABRIC, spawnerOnly: true },
    }, MODELS, ACCOUNTS, applier);
    expect(binds).toEqual([]);
    expect(report.wired[0].name).toBe("HIDDEN");
  });

  it("leaves a named env miss unresolved instead of throwing", async () => {
    let { applier, created } = stubApplier();
    let { report } = await applyBlueprintWiring(1, {
      SPAWNER: {
        type: "agentSpawner",
        title: "Spawner",
        description: "",
        suggestedModel: null,
        env: { OTHER: { type: "binding", name: "MISSING" } },
      },
    }, MODELS, ACCOUNTS, applier);
    expect(created).toEqual([]);
    expect(report.unresolved[0].reason)
        .toBe("Needs setup: referenced binding MISSING was not assigned");
  });

  it("reports a missing model suggestion with the landing-page vocabulary", async () => {
    let { applier } = stubApplier();
    let { report } = await applyBlueprintWiring(1, {
      AI: { type: "aiModel", title: "Model", description: "" },
    }, MODELS, ACCOUNTS, applier);
    expect(report.unresolved[0].reason).toBe(NO_SUGGESTION_REASON);
  });

  it("reports a catalog miss with the landing-page vocabulary", async () => {
    let { applier } = stubApplier();
    let { report } = await applyBlueprintWiring(1, {
      AGENT: {
        type: "agentSpawner",
        title: "Agent",
        description: "",
        suggestedModel: { provider: "anthropic", modelName: "does-not-exist" },
        env: { GADGET: { type: "gadget" } },
      },
    }, MODELS, ACCOUNTS, applier);
    expect(report.unresolved[0].reason)
        .toBe(suggestedModelMissingReason("anthropic", "does-not-exist"));
  });
});

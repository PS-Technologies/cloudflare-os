import type { AgentSpawnerConfig, BlueprintBinding, WorkpieceId } from "@gadgets/workshop-shared/api";

/**
 * One model from the acting user's catalog (AuthenticatedApi.listModels / UserDurableObject.listModels).
 * `findSuggestedModelId` matches on `id` and `name` exactly as BlueprintLandingPage does.
 */
export type CatalogModel = { id: string; name: string };

/**
 * One connected account from the acting user's Connectors list, carrying the fields
 * subscribeConnectedAccounts delivers: vendorId, credentialsValid, supportedResources.
 */
export type CatalogAccount = {
  id: number;
  vendorId: string;
  credentialsValid: boolean;
  supportedResources: { urlPattern: string }[];
};

export type WiringRow = {
  name: string;
  type: "gatekeeper" | "aiModel" | "agentSpawner";
  detail: string;
};

export type UnresolvedRow = {
  name: string;
  type: "gatekeeper" | "aiModel" | "agentSpawner";
  reason: string;
};

export type WiringReport = {
  wired: WiringRow[];
  unresolved: UnresolvedRow[];
};

export type WiringApplier = {
  createGatekeeper(accountId: number, resourceUrl: string): Promise<WorkpieceId>;
  createAiModel(modelId: string): Promise<WorkpieceId>;
  createAgentSpawner(config: AgentSpawnerConfig): Promise<WorkpieceId>;
  bind(name: string, target: WorkpieceId): void;
};

/**
 * Ported verbatim from BlueprintLandingPage.tsx findSuggestedModelId: exact id/name match
 * (`id`, `name`, `${provider}/${modelName}`, `${provider}:${modelName}`), else the single
 * provider-scoped substring match, else unresolved.
 */
export function findSuggestedModelId(
    suggested: {provider: string, modelName: string},
    models: ReadonlyArray<CatalogModel>): string | null {
  const provider = suggested.provider.trim().toLowerCase()
  const modelName = suggested.modelName.trim().toLowerCase()
  const exactMatches = models.filter(model =>
    model.id.toLowerCase() === modelName ||
    model.name.toLowerCase() === modelName ||
    model.id.toLowerCase() === `${provider}/${modelName}` ||
    model.id.toLowerCase() === `${provider}:${modelName}`
  )
  if (exactMatches.length === 1) return exactMatches[0].id

  const providerScopedMatches = models.filter(model => {
    const text = `${model.id} ${model.name}`.toLowerCase()
    return text.includes(provider) && text.includes(modelName)
  })
  return providerScopedMatches.length === 1 ? providerScopedMatches[0].id : null
}

/**
 * Ported verbatim from BlueprintLandingPage.tsx findMatchingAccounts: vendor case-insensitive,
 * credentialsValid, and a supported resource whose urlPattern equals typeUrlPattern.
 */
export function findMatchingAccounts(
    binding: { gatekeeperName: string; typeUrlPattern: string },
    accounts: ReadonlyArray<CatalogAccount>): CatalogAccount[] {
  return accounts.filter(account =>
    account.vendorId.toLowerCase() === binding.gatekeeperName.toLowerCase() &&
    account.credentialsValid &&
    account.supportedResources.some(resource => resource.urlPattern === binding.typeUrlPattern)
  )
}

export function noConnectedAccountReason(gatekeeperName: string, typeUrlPattern: string): string {
  return `Needs setup: no connected ${gatekeeperName} account offers ${typeUrlPattern}`;
}

export function suggestedModelMissingReason(provider: string, modelName: string): string {
  return `Needs setup: suggested model ${provider}/${modelName} is not in your catalog`;
}

export const NO_SUGGESTION_REASON = "No suggestion recorded on the blueprint";

/** Human-readable wiring report for the createGadget tool result. */
export function formatWiringReport(report: WiringReport): string {
  let lines: string[] = [];
  if (report.wired.length > 0) {
    lines.push("Wired connections:");
    for (let row of report.wired) {
      lines.push(`* ${row.name} — ${row.type} — ${row.detail}`);
    }
  }
  if (report.unresolved.length > 0) {
    lines.push("Still needs Connections:");
    for (let row of report.unresolved) {
      lines.push(`* ${row.name} — ${row.type} — ${row.reason}`);
    }
  }
  return lines.join("\n");
}

export function countsByType(rows: {type: string}[]): string {
  let counts = new Map<string, number>();
  for (let row of rows) counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
  return [...counts].map(([type, n]) => `${type}:${n}`).join(",") || "none";
}

/**
 * Resolve and apply a blueprint's bindings in the two-phase order of
 * server.ts newGadgetFromBlueprint: gatekeeper and aiModel rows first (skip binding into the
 * gadget for spawnerOnly), then agent spawners. A missing named env target is unresolved, not a
 * throw. Does not normalise resource URLs.
 */
export async function applyBlueprintWiring(
    gadgetId: WorkpieceId,
    bindings: Record<string, BlueprintBinding>,
    models: ReadonlyArray<CatalogModel>,
    accounts: ReadonlyArray<CatalogAccount>,
    applier: WiringApplier,
): Promise<{ report: WiringReport; addedBindings: {name: string; target: WorkpieceId}[] }> {
  let wired: WiringRow[] = [];
  let unresolved: UnresolvedRow[] = [];
  let addedBindings: {name: string; target: WorkpieceId}[] = [];
  let createdIds = new Map<string, WorkpieceId>();

  let pushUnresolved = (name: string, type: UnresolvedRow["type"], reason: string) => {
    unresolved.push({ name, type, reason });
  };

  let bindIfNeeded = (name: string, binding: BlueprintBinding, target: WorkpieceId) => {
    if (binding.spawnerOnly) return;
    applier.bind(name, target);
    addedBindings.push({ name, target });
  };

  for (let [name, binding] of Object.entries(bindings)) {
    if (binding.type === "agentSpawner") continue;

    if (binding.type === "gatekeeper") {
      if (!binding.resourceUrl) {
        pushUnresolved(name, "gatekeeper",
            noConnectedAccountReason(binding.gatekeeperName, binding.typeUrlPattern));
        continue;
      }
      let matches = findMatchingAccounts(binding, accounts);
      if (matches.length !== 1) {
        pushUnresolved(name, "gatekeeper",
            noConnectedAccountReason(binding.gatekeeperName, binding.typeUrlPattern));
        continue;
      }
      let target = await applier.createGatekeeper(matches[0].id, binding.resourceUrl);
      createdIds.set(name, target);
      bindIfNeeded(name, binding, target);
      wired.push({
        name, type: "gatekeeper",
        detail: `${binding.gatekeeperName} ${binding.resourceUrl}`,
      });
      continue;
    }

    if (!binding.suggestedModel) {
      pushUnresolved(name, "aiModel", NO_SUGGESTION_REASON);
      continue;
    }
    let modelId = findSuggestedModelId(binding.suggestedModel, models);
    if (!modelId) {
      pushUnresolved(name, "aiModel",
          suggestedModelMissingReason(
              binding.suggestedModel.provider, binding.suggestedModel.modelName));
      continue;
    }
    let target = await applier.createAiModel(modelId);
    createdIds.set(name, target);
    bindIfNeeded(name, binding, target);
    wired.push({ name, type: "aiModel", detail: modelId });
  }

  for (let [name, binding] of Object.entries(bindings)) {
    if (binding.type !== "agentSpawner") continue;

    let modelId: string | null;
    if (binding.suggestedModel === null) {
      modelId = null;
    } else if (binding.suggestedModel) {
      let resolved = findSuggestedModelId(binding.suggestedModel, models);
      if (!resolved) {
        pushUnresolved(name, "agentSpawner",
            suggestedModelMissingReason(
                binding.suggestedModel.provider, binding.suggestedModel.modelName));
        continue;
      }
      modelId = resolved;
    } else {
      pushUnresolved(name, "agentSpawner", NO_SUGGESTION_REASON);
      continue;
    }

    let env: Record<string, WorkpieceId> = {};
    let missingTarget: string | undefined;
    for (let [envName, target] of Object.entries(binding.env)) {
      if (target.type === "gadget") {
        env[envName] = gadgetId;
      } else {
        let id = createdIds.get(target.name);
        if (id === undefined) {
          missingTarget = target.name;
          break;
        }
        env[envName] = id;
      }
    }
    if (missingTarget !== undefined) {
      pushUnresolved(name, "agentSpawner",
          `Needs setup: referenced binding ${missingTarget} was not assigned`);
      continue;
    }

    let spawnerId = await applier.createAgentSpawner({
      displayName: binding.title,
      modelId,
      env,
    });
    createdIds.set(name, spawnerId);
    bindIfNeeded(name, binding, spawnerId);
    wired.push({
      name, type: "agentSpawner",
      detail: modelId === null ? "no model" : modelId,
    });
  }

  return { report: { wired, unresolved }, addedBindings };
}

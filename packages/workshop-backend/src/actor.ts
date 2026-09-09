// Resolves the person a binding session should execute as, from the overseer's already-stored
// account choices. The overseer never invents an identity: no profileId means headless, and a
// named person whose chosen account is gone is returned without a verifier so the gatekeeper can
// refuse rather than fall back to the creator.

import type {
  GatekeeperSessionActor,
  GatekeeperUserVerifier,
} from "@gadgets/workshop-shared/gatekeeper";

/** The owner's per-binding account choices, stored so a query can run as them after they leave. */
export type ActorAccountRecord = {
  profileId: string;
  accountChoices: { [gatekeeperId: number]: number };
};

export type ActorChoiceRecord = {
  observerId?: string;
  accountChoices: { [gatekeeperId: number]: number };
};

/**
 * Pick the session actor for one gatekeeper. `vendorId` null means the binding has no per-user
 * credential (AI model, spawner) and needs no actor.
 */
export async function resolveSessionActor(
    profileId: string | undefined,
    gatekeeperId: number,
    vendorId: string | null,
    observer: ActorChoiceRecord | undefined,
    ownerChoices: ActorChoiceRecord | undefined,
    getVerifier: (
      profileId: string, accountId: number, vendorId: string,
    ) => Promise<Fetcher<GatekeeperUserVerifier> | null>,
): Promise<GatekeeperSessionActor | undefined> {
  if (profileId === undefined || vendorId === null) return undefined;

  const choices = observer?.accountChoices ?? ownerChoices?.accountChoices;
  const accountId = choices?.[gatekeeperId];
  const observerId = observer?.observerId;
  if (accountId === undefined) {
    return { observerId };
  }

  const verifier = await getVerifier(profileId, accountId, vendorId);
  if (!verifier) return { observerId };
  return { observerId, verifier };
}

import { describe, expect, it } from "vitest";
import type { GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { UserDurableObject } from "../src/user.js";

// A user with one non-ambient connected account whose handle behaves as the caller decides: a live
// connector answers revoke(); a connector Worker that was deleted and recreated fails every call.
function makeUser(revoke: () => Promise<void>) {
  let revoked = 0;
  const deleted: number[] = [];
  const account = {
    async revoke() { revoked++; await revoke(); },
  } as unknown as Fetcher<GatekeeperUser>;
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    storage: {
      connectedAccounts: {
        get: (accountId: number) => accountId === 34
          ? { id: accountId, account, vendorId: "mcp_portal", autoProvisioned: false }
          : undefined,
        delete: (accountId: number) => { deleted.push(accountId); },
      },
      cloudflareBilling: { put: () => { throw new Error("not a Cloudflare account"); } },
    },
  });
  return { user, revoked: () => revoked, deleted };
}

describe("UserDurableObject.disconnectAccount", () => {
  it("revokes and deletes a live account", async () => {
    const { user, revoked, deleted } = makeUser(async () => {});

    await expect(user.disconnectAccount(34)).resolves.toBeUndefined();
    expect(revoked()).toBe(1);
    expect(deleted).toEqual([34]);
  });

  it("still deletes the row when revoke() fails on a dead handle", async () => {
    const { user, revoked, deleted } = makeUser(async () => {
      throw new Error("internal error; reference = c5uqk8k7ha551fe3qqum7bef");
    });

    await expect(user.disconnectAccount(34)).resolves.toBeUndefined();
    expect(revoked()).toBe(1);
    expect(deleted).toEqual([34]);
  });

  it("does nothing for an account that does not exist", async () => {
    const { user, revoked, deleted } = makeUser(async () => {});

    await expect(user.disconnectAccount(35)).resolves.toBeUndefined();
    expect(revoked()).toBe(0);
    expect(deleted).toEqual([]);
  });
});

import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { DeviceSessionHandoff } from "../src/auth/device-session-handoff";
import { deviceSessionCallback } from "../src/auth/device-session-callback";
import server from "../src/server";

const origin = "https://install.example.test";
const state = "ABCDEFab-0000-0000-0000-000000000001";
const userDoId = "a".repeat(64);
const ticket = "b".repeat(64);
const fields = { userDoId, state, ticket };
const handoff: DeviceSessionHandoff = {
  publicKey: "A".repeat(87),
  salt: "B".repeat(43),
  iv: "C".repeat(16),
  ciphertext: "D".repeat(128),
};

function request(body: URLSearchParams, options?: {
  origin?: string;
  method?: string;
  mode?: string;
  destination?: string;
}): Request {
  return new Request(`${origin}/api/device-session/callback`, {
    method: options?.method ?? "POST",
    headers: {
      Origin: options?.origin ?? origin,
      "Content-Type": "application/x-www-form-urlencoded",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": options?.mode ?? "navigate",
      "Sec-Fetch-Dest": options?.destination ?? "document",
    },
    body: options?.method === "GET" ? undefined : body,
  });
}

describe("device session callback", () => {
  it("redeems a staged transfer through the Worker route exactly once", async () => {
    const user = env.TEST_USER.getByName(`device-session-route-${crypto.randomUUID()}`);
    await user.authenticateFromCfAccess("route-user@example.com", true);
    const key = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    const publicKey = new Uint8Array(
        await crypto.subtle.exportKey("raw", key.publicKey) as ArrayBuffer)
        .toBase64({ alphabet: "base64url", omitPadding: true });
    const start = await user.stageDeviceSessionHandoff(publicKey, state);
    const body = new URLSearchParams({ ...start, state });

    const enabledEnv = { ...env, ENABLE_DEVICE_SESSION_HANDOFF: "true" };
    const response = await server.fetch(request(body), enabledEnv, createExecutionContext());
    expect(response.status).toBe(303);
    const callback = new URL(response.headers.get("Location")!);
    expect(callback.origin + callback.pathname).toBe("https://os.cloudflare.app/oauthredirect");
    expect(callback.searchParams.get("state")).toBe(state);
    expect(callback.searchParams.get("ciphertext")).toBeTruthy();

    const replay = await server.fetch(request(body), enabledEnv, createExecutionContext());
    expect(replay.status).toBe(410);
  });

  it("refuses the Worker route and callback helper when handoff is not explicitly enabled", async () => {
    const consume = vi.fn().mockResolvedValue(handoff);
    const body = new URLSearchParams(fields);

    const routeResponse = await server.fetch(request(body), env, createExecutionContext());
    expect(routeResponse.status).toBe(403);
    expect(routeResponse.headers.get("Cache-Control")).toBe("no-store");

    const helperResponse = await deviceSessionCallback(request(body), consume);
    expect(helperResponse.status).toBe(403);
    expect(consume).not.toHaveBeenCalled();
  });

  it("consumes the server-held handoff and redirects to the claimed HTTPS app link", async () => {
    const consume = vi.fn().mockResolvedValue(handoff);
    const response = await deviceSessionCallback(
      request(new URLSearchParams(fields)),
      consume,
      { enabled: true },
    );
    expect(consume).toHaveBeenCalledWith(userDoId, state, ticket);
    expect(response.status).toBe(303);
    const callback = new URL(response.headers.get("Location")!);
    expect(callback.origin + callback.pathname).toBe("https://os.cloudflare.app/oauthredirect");
    expect(Object.fromEntries(callback.searchParams)).toEqual({
      cfos_callback: "install-connected",
      state,
      ...handoff,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("rejects script fetches, frames, cross-origin posts, and malformed handles", async () => {
    const consume = vi.fn().mockResolvedValue(handoff);
    for (const candidate of [
      request(new URLSearchParams(fields), { mode: "cors" }),
      request(new URLSearchParams(fields), { destination: "iframe" }),
      request(new URLSearchParams(fields), { origin: "https://other.test" }),
      request(new URLSearchParams({ ...fields, userDoId: "bad" })),
      request(new URLSearchParams({ userDoId, state })),
      request(new URLSearchParams({ ...fields, ticket: "bad" })),
      request(new URLSearchParams([
        ["userDoId", userDoId], ["state", state], ["state", state], ["ticket", ticket],
      ])),
      request(new URLSearchParams([
        ["userDoId", userDoId], ["state", state], ["ticket", ticket], ["ticket", ticket],
      ])),
      request(new URLSearchParams(fields), { method: "GET" }),
    ]) {
      expect((await deviceSessionCallback(
        candidate, consume, { enabled: true })).status).toBeGreaterThanOrEqual(400);
    }
    expect(consume).not.toHaveBeenCalled();
  });

  it("reports an already consumed or expired transfer", async () => {
    const response = await deviceSessionCallback(
      request(new URLSearchParams(fields)),
      vi.fn().mockResolvedValue(null),
      { enabled: true },
    );
    expect(response.status).toBe(410);
  });

  it("rejects another Access user's handoff before consuming its ticket", async () => {
    const consume = vi.fn().mockResolvedValue(handoff);
    const response = await deviceSessionCallback(
      request(new URLSearchParams(fields)),
      consume,
      { enabled: true, expectedUserDoId: "c".repeat(64) },
    );
    expect(response.status).toBe(403);
    expect(consume).not.toHaveBeenCalled();
  });

  it("rejects forged navigation headers without an Access assertion on the Worker route", async () => {
    const response = await server.fetch(
      request(new URLSearchParams(fields)),
      {
        ...env,
        CF_ACCESS_AUD: "audience",
        CF_ACCESS_ISS: "https://access.example",
        ENABLE_DEVICE_SESSION_HANDOFF: "true",
      },
      {} as ExecutionContext,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not disguise a storage failure as an expired transfer", async () => {
    await expect(deviceSessionCallback(
      request(new URLSearchParams(fields)),
      vi.fn().mockRejectedValue(new Error("storage unavailable")),
      { enabled: true },
    )).rejects.toThrow("storage unavailable");
  });
});

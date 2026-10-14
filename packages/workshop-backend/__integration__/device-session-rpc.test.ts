import type { PublicApi } from "@gadgets/workshop-shared/api";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { expect, it } from "vitest";
import server from "../src/server";

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await server.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }), env, createExecutionContext());
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

it("refuses device-session handoff through authenticated RPC unless explicitly enabled", async () => {
  using publicApi = await connect();
  const username = `devicehandoff${crypto.randomUUID().replaceAll("-", "")}`;
  const token = await publicApi.createAccount(
    username,
    "Device Handoff Test",
    new Uint8Array([1, 2, 3]),
  );
  if (token === null) throw new Error(`Failed to create ${username}.`);
  using authenticated = await publicApi.authenticate(token);

  await expect(authenticated.beginDeviceSessionHandoff("not-a-key", "not-a-state"))
    .rejects.toThrow("Native device-session handoff is disabled for this deployment.");
});

// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// Principle: the home page's Ask Watts hands a question to Dispatch's home route to send at once.

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => {
  const workspace = {
    newChat: vi.fn<(...args: unknown[]) => Promise<string>>(async () => "chat-1"),
    getMetadata: vi.fn<() => Promise<{ id: string }>>(async () => ({ id: "workspace-1" })),
    [Symbol.dispose]: () => {},
  };
  const listModels = vi.fn<() => Promise<Array<{ id: string }>>>(
    async () => [{ id: "model-a" }, { id: "model-b" }]);
  const newWorkspace = vi.fn<() => typeof workspace>(() => workspace);
  return {
    addToast: vi.fn<(toast: unknown) => void>(),
    authenticatedApi: { listModels, newWorkspace },
    currentUser: { id: "user-a", name: "User A" },
    listModels,
    navigate: vi.fn<(options: unknown) => void>(),
    newWorkspace,
    workspace,
    seeds: [] as Array<{ text?: string; nonce?: number }>,
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => testState.navigate,
}));

vi.mock("@cloudflare/kumo", () => ({
  useKumoToastManager: () => ({ add: testState.addToast }),
}));

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: testState.authenticatedApi,
    currentUser: testState.currentUser,
  }),
}));

vi.mock("./features/chat/composer/ChatComposer", () => ({
  ChatComposer: ({ seedText, seedNonce, blockedReason }:
    { seedText?: string; seedNonce?: number; blockedReason?: string }) => {
    testState.seeds.push({ text: seedText, nonce: seedNonce });
    return <textarea aria-label="Prompt" readOnly disabled={blockedReason !== undefined}
      value={seedText ?? ""} />;
  },
}));

vi.mock("./components/MeshBackground", () => ({ default: () => null }));
vi.mock("./components/AppShell/HomeTaskSuggestions", () => ({
  default: ({ onPick }: { onPick: (suggestion: string) => void }) =>
    <button type="button" onClick={() => onPick(SUGGESTION)}>Suggestion</button>,
}));
vi.mock("./features/deployment-updates/UpdateAvailableNotice", () => ({ UpdateAvailableNotice: () => null }));
vi.mock("./useDocumentTitle", () => ({ useDocumentTitle: () => {} }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const QUESTION = "Summarize the LCRA T-FCC bid";
const SUGGESTION = "Draft a status update";
const OPENED_FOR_QUESTION =
  `https://dispatch.principlesvc.app/?${new URLSearchParams({ prompt: JSON.stringify(QUESTION), send: "1" })}`;

/** The page as the browser opened it: from `referrer`, at `opened`. */
function arrive(referrer: string, opened = OPENED_FOR_QUESTION) {
  Object.defineProperty(document, "referrer", { value: referrer, configurable: true });
  vi.spyOn(performance, "getEntriesByType").mockReturnValue(
    [{ name: opened, type: "navigate" } as unknown as PerformanceEntry]);
}

const seededWith = (text: string) => testState.seeds.some((seed) => seed.text === text);
const composer = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')!;

/** A send that waits until the test settles it. */
function sendHeld() {
  let fail!: (err: Error) => void;
  testState.workspace.newChat.mockImplementationOnce(
    () => new Promise((_, reject) => { fail = reject; }));
  return { fail: (err: Error) => act(async () => fail(err)) };
}

describe("Home's Ask Watts hand-off", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  async function renderHome(prompt: string | undefined) {
    const { HomePageContent } = await import("./routes/index");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    // As main.tsx renders it: StrictMode calls state initializers twice and mounts effects twice.
    await act(async () => root!.render(<StrictMode><HomePageContent prompt={prompt} /></StrictMode>));
  }

  async function leaveHome() {
    await act(async () => root?.unmount());
    container?.remove();
  }

  beforeEach(() => {
    // The hand-off is taken once per page, so every test opens a fresh one.
    vi.resetModules();
  });

  afterEach(async () => {
    await leaveHome();
    Reflect.deleteProperty(document, "referrer");
    localStorage.clear();
    testState.seeds.length = 0;
    testState.listModels.mockReset();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("sends the question with the saved model and opens the conversation, never filling the composer", async () => {
    localStorage.setItem("lastSelectedModel", "model-b");
    arrive("https://home.principlesvc.app/");
    await renderHome(QUESTION);

    expect(testState.workspace.newChat).toHaveBeenCalledTimes(1);
    expect(testState.workspace.newChat.mock.calls[0]?.slice(0, 2)).toEqual([QUESTION, "model-b"]);
    expect(testState.navigate).toHaveBeenCalledWith(
      { to: "/workspace/$id", params: { id: "workspace-1" }, search: { chat: "chat-1" } });
    // Filling the composer would save a draft of a question that has already gone.
    expect(seededWith(QUESTION)).toBe(false);
  });

  it("leaves the question in the composer when the send fails", async () => {
    testState.workspace.newChat.mockRejectedValueOnce(new Error("Model is disabled"));
    arrive("https://home.principlesvc.app/");
    await renderHome(QUESTION);

    expect(testState.workspace.newChat).toHaveBeenCalledTimes(1);
    expect(seededWith(QUESTION)).toBe(true);
    expect(testState.navigate).not.toHaveBeenCalledWith(expect.objectContaining({ to: "/workspace/$id" }));
  });

  it("closes the composer while the question is on its way, and opens it with the question if it fails", async () => {
    const send = sendHeld();
    arrive("https://home.principlesvc.app/");
    await renderHome(QUESTION);

    // Open, a second send would start another chat in the same workspace.
    expect(composer().disabled).toBe(true);
    await send.fail(new Error("Model is disabled"));
    expect(composer().disabled).toBe(false);
    expect(seededWith(QUESTION)).toBe(true);
  });

  it("keeps a suggestion picked while the question is on its way when the send fails", async () => {
    const send = sendHeld();
    arrive("https://home.principlesvc.app/");
    await renderHome(QUESTION);
    await act(async () => document.querySelector("button")!.click());
    await send.fail(new Error("Model is disabled"));

    expect(testState.seeds.at(-1)?.text).toBe(SUGGESTION);
    expect(seededWith(QUESTION)).toBe(false);
  });

  it("leaves the question in the composer when the models do not load, without sending", async () => {
    testState.listModels.mockRejectedValue(new Error("Models unavailable"));
    arrive("https://home.principlesvc.app/");
    await renderHome(QUESTION);

    expect(testState.newWorkspace).not.toHaveBeenCalled();
    expect(seededWith(QUESTION)).toBe(true);
    expect(composer().disabled).toBe(false);
  });

  it("only fills the composer when the page was opened from anywhere but home", async () => {
    arrive("https://evil.example/");
    await renderHome(QUESTION);

    expect(testState.newWorkspace).not.toHaveBeenCalled();
    expect(seededWith(QUESTION)).toBe(true);
    expect(composer().disabled).toBe(false);
  });

  it("gives the question up on leaving before the models load: coming back with it only fills the composer", async () => {
    testState.listModels.mockImplementation(() => new Promise(() => {}));
    arrive("https://home.principlesvc.app/");
    await renderHome(QUESTION);
    await leaveHome();
    testState.listModels.mockReset();

    // A gatekeeper app opening Dispatch's home with the same question, without asking to send it.
    await renderHome(QUESTION);
    expect(testState.newWorkspace).not.toHaveBeenCalled();
    expect(seededWith(QUESTION)).toBe(true);
  });

  it("sends once per page: coming back with the same address only fills the composer", async () => {
    arrive("https://home.principlesvc.app/");
    await renderHome(QUESTION);
    expect(testState.workspace.newChat).toHaveBeenCalledTimes(1);
    await leaveHome();

    // An in-app link back to the same address keeps home as the referrer and the same opening entry.
    await renderHome(QUESTION);
    expect(testState.workspace.newChat).toHaveBeenCalledTimes(1);
    expect(seededWith(QUESTION)).toBe(true);
  });
});

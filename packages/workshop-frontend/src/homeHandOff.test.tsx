// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// Principle: the home page's Ask Watts hands a question to Dispatch. The home route sends it on to
// /start before anything renders, and /start opens a chat with it in a new workspace, showing the
// question and Watts thinking from the first frame.

import { act, StrictMode, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => {
  const dispose = vi.fn<() => void>();
  const workspace = {
    newChat: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 0),
    getMetadata: vi.fn<() => Promise<{ id: string }>>(async () => ({ id: "workspace-1" })),
    [Symbol.dispose]: dispose,
  };
  const listModels = vi.fn<() => Promise<Array<{ id: string }>>>(
    async () => [{ id: "model-a" }, { id: "model-b" }]);
  const newWorkspace = vi.fn<() => typeof workspace>(() => workspace);
  return {
    authenticatedApi: { listModels, newWorkspace },
    currentUser: { id: "user-a", name: "User A" },
    dispose,
    listModels,
    navigate: vi.fn<(options: unknown) => Promise<void>>(async () => {}),
    realNavigation: false,
    newWorkspace,
    workspace,
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...original,
    useNavigate: () => testState.realNavigation ? original.useNavigate() : testState.navigate,
    Link: ({ children, to, ...props }: { children: ReactNode; to: string }) =>
      <a href={to} {...props}>{children}</a>,
  };
});

vi.mock("@cloudflare/kumo", () => ({ useKumoToastManager: () => ({ add: () => {} }) }));
vi.mock("./components/WorkshopControls", () => ({
  WorkshopButton: ({ children, tone: _tone, ...props }: ComponentProps<"button"> & { tone?: string }) =>
    <button type="button" {...props}>{children}</button>,
}));

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: testState.authenticatedApi,
    currentUser: testState.currentUser,
  }),
}));

// The home page itself never renders for a hand-off; these keep its route module importable.
vi.mock("./features/chat/composer/ChatComposer", () => ({ ChatComposer: () => <textarea aria-label="Prompt" /> }));
vi.mock("./components/MeshBackground", () => ({ default: () => null }));
vi.mock("./components/AppShell/HomeTaskSuggestions", () => ({ default: () => null }));
vi.mock("./features/deployment-updates/UpdateAvailableNotice", () => ({ UpdateAvailableNotice: () => null }));
vi.mock("./useDocumentTitle", () => ({ useDocumentTitle: () => {} }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const QUESTION = "Summarize the LCRA T-FCC bid";
const ASKED = new URLSearchParams({ prompt: JSON.stringify(QUESTION), send: "1" });
const OPENED_FOR_QUESTION = `https://dispatch.principlesvc.app/?${ASKED}`;
const START_ADDRESS = `/start?${new URLSearchParams({ prompt: JSON.stringify(QUESTION) })}`;
const TO_WORKSPACE = {
  to: "/workspace/$id", params: { id: "workspace-1" }, search: { chat: 0 }, replace: true,
};
const BACK_HOME = { to: "/", search: { prompt: QUESTION }, replace: true };

/** The page as the browser opened it: from `referrer`, at `opened`. */
function arrive(referrer: string, opened = OPENED_FOR_QUESTION, type = "navigate") {
  Object.defineProperty(document, "referrer", { value: referrer, configurable: true });
  vi.spyOn(performance, "getEntriesByType").mockReturnValue(
    [{ name: opened, type } as unknown as PerformanceEntry]);
}

/** A promise the test settles. */
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const bubble = () => document.querySelector(".bg-kumo-bubble-user");
const text = () => document.body.textContent ?? "";
const tryAgain = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
/** Lets the start's queued work and the promises it awaits run. */
async function settle() {
  for (let turn = 0; turn < 5; turn++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

const workspaceOpened = () =>
  testState.navigate.mock.calls.some(([options]) => (options as { to: string }).to === "/workspace/$id");

describe("Home's Ask Watts hand-off", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  /** /start as the router mounts it, under StrictMode as main.tsx renders it. */
  async function renderStart(prompt: string | undefined) {
    const { StartPageContent } = await import("./routes/start");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<StrictMode><StartPageContent prompt={prompt} /></StrictMode>));
  }

  /** /start rendered again in place, as a change in what it reads from its context does. */
  async function rerenderStart(prompt: string | undefined) {
    const { StartPageContent } = await import("./routes/start");
    await act(async () => root!.render(<StrictMode><StartPageContent prompt={prompt} /></StrictMode>));
  }

  async function leave() {
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
  }

  beforeEach(() => {
    // The hand-off is taken once per page, and the pending start lives in memory, so every test
    // opens a fresh page.
    vi.resetModules();
    testState.realNavigation = false;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await leave();
    testState.authenticatedApi = { listModels: testState.listModels, newWorkspace: testState.newWorkspace };
    Reflect.deleteProperty(document, "referrer");
    localStorage.clear();
    testState.listModels.mockReset();
    testState.listModels.mockImplementation(async () => [{ id: "model-a" }, { id: "model-b" }]);
    testState.navigate.mockReset();
    testState.navigate.mockImplementation(async () => {});
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("sends a home hand-off at / on to /start before the home page renders, then into its workspace", async () => {
    const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, Outlet } =
      await import("@tanstack/react-router");
    const { Route: HomeRoute } = await import("./routes/index");
    const { Route: StartRoute, StartPageContent } = await import("./routes/start");
    testState.realNavigation = true;
    arrive("https://home.principlesvc.app/");
    const homeRendered = vi.fn<() => void>();
    const rootRoute = createRootRoute({ component: Outlet });
    const homeRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      validateSearch: HomeRoute.options.validateSearch,
      beforeLoad: HomeRoute.options.beforeLoad,
      component: () => { homeRendered(); return <p>Home page</p>; },
    });
    const startRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/start",
      validateSearch: StartRoute.options.validateSearch,
      component: () => <StartPageContent prompt={startRoute.useSearch().prompt} />,
    });
    const workspaceRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/workspace/$id",
      component: () => <p>Workspace chat</p>,
    });
    const history = createMemoryHistory({ initialEntries: [`/?${ASKED}`] });
    const router = createRouter({
      routeTree: rootRoute.addChildren([homeRoute, startRoute, workspaceRoute]),
      history,
    });
    let loadModels!: (models: Array<{ id: string }>) => void;
    testState.listModels.mockImplementation(() => new Promise((resolve) => { loadModels = resolve; }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      await router.load();
      root!.render(<StrictMode><RouterProvider router={router} /></StrictMode>);
    });
    await settle();

    expect(router.state.location.pathname).toBe("/start");
    expect(router.state.location.search).toEqual({ prompt: QUESTION });
    expect(homeRendered).not.toHaveBeenCalled();
    expect(bubble()?.textContent).toBe(QUESTION);

    await act(async () => loadModels([{ id: "model-a" }]));
    await settle();
    expect(testState.workspace.newChat).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe("/workspace/workspace-1");
    expect(router.state.location.search).toEqual({ chat: 0 });
    // Both moves replaced the page's entry, so Back leaves for home rather than starting again.
    expect(history.length).toBe(1);
    expect(homeRendered).not.toHaveBeenCalled();
  });

  it("leaves / alone when the page was not handed a question by home", async () => {
    const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, Outlet } =
      await import("@tanstack/react-router");
    const { Route: HomeRoute } = await import("./routes/index");
    testState.realNavigation = true;
    arrive("https://evil.example/");
    const rootRoute = createRootRoute({ component: Outlet });
    const homeRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      validateSearch: HomeRoute.options.validateSearch,
      beforeLoad: HomeRoute.options.beforeLoad,
      component: () => <p>Home page</p>,
    });
    const startRoute = createRoute({ getParentRoute: () => rootRoute, path: "/start", component: () => null });
    const router = createRouter({
      routeTree: rootRoute.addChildren([homeRoute, startRoute]),
      history: createMemoryHistory({ initialEntries: [`/?${ASKED}`] }),
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      await router.load();
      root!.render(<RouterProvider router={router} />);
    });

    expect(router.state.location.pathname).toBe("/");
    expect(text()).toContain("Home page");
  });

  it("shows the question and Watts thinking at once, then sends it once with the saved model", async () => {
    localStorage.setItem("lastSelectedModel", "model-b");
    arrive("https://home.principlesvc.app/");
    await renderStart(QUESTION);

    expect(bubble()?.textContent).toBe(QUESTION);
    expect(text()).toContain("Thinking");
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    await settle();

    expect(testState.newWorkspace).toHaveBeenCalledTimes(1);
    expect(testState.workspace.newChat).toHaveBeenCalledTimes(1);
    expect(testState.workspace.newChat.mock.calls[0]).toEqual([QUESTION, "model-b"]);
    expect(testState.navigate).toHaveBeenCalledTimes(1);
    expect(testState.navigate).toHaveBeenCalledWith(TO_WORKSPACE);
    expect(testState.dispose).toHaveBeenCalledTimes(1);
    const { principleStartFor } = await import("./principleStart");
    expect(principleStartFor("workspace-1")).toEqual({ id: "workspace-1", chat: 0, question: QUESTION });
  });

  it("falls back to the first model when the saved one is gone", async () => {
    localStorage.setItem("lastSelectedModel", "model-retired");
    arrive("https://home.principlesvc.app/");
    await renderStart(QUESTION);
    await settle();

    expect(testState.workspace.newChat.mock.calls[0]).toEqual([QUESTION, "model-a"]);
  });

  it("honours a saved choice of no agent, as Send would", async () => {
    const { NO_AGENT_OPTION_VALUE } = await import("./modelSelection");
    localStorage.setItem("lastSelectedModel", NO_AGENT_OPTION_VALUE);
    arrive("https://home.principlesvc.app/");
    await renderStart(QUESTION);
    await settle();

    expect(testState.workspace.newChat.mock.calls[0]).toEqual([QUESTION, null]);
  });

  it("starts nothing more under StrictMode's second mount", async () => {
    arrive("https://home.principlesvc.app/");
    await renderStart(QUESTION);
    await settle();

    expect(testState.newWorkspace).toHaveBeenCalledTimes(1);
    expect(testState.listModels).toHaveBeenCalledTimes(1);
    expect(testState.workspace.newChat).toHaveBeenCalledTimes(1);
    expect(testState.navigate).toHaveBeenCalledTimes(1);
  });

  it("starts once when its API is replaced mid-start, and opens that chat's workspace", async () => {
    const chat = held<number>();
    testState.workspace.newChat.mockImplementationOnce(() => chat.promise);
    arrive("https://home.principlesvc.app/");
    await renderStart(QUESTION);
    await settle();
    expect(testState.workspace.newChat).toHaveBeenCalledTimes(1);

    // Signing in again hands /start a new API while the chat is being made.
    testState.authenticatedApi = { ...testState.authenticatedApi };
    await rerenderStart(QUESTION);
    await settle();
    await act(async () => chat.resolve(0));
    await settle();

    expect(testState.newWorkspace).toHaveBeenCalledTimes(1);
    expect(testState.workspace.newChat).toHaveBeenCalledTimes(1);
    expect(testState.navigate).toHaveBeenCalledTimes(1);
    expect(testState.navigate).toHaveBeenCalledWith(TO_WORKSPACE);
    expect(testState.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not open the workspace after the person has left, and lets the workspace go once its calls settle", async () => {
    const chat = held<number>();
    testState.workspace.newChat.mockImplementationOnce(() => chat.promise);
    arrive("https://home.principlesvc.app/");
    await renderStart(QUESTION);
    await settle();
    expect(testState.workspace.newChat).toHaveBeenCalledTimes(1);

    await leave();
    expect(testState.dispose).not.toHaveBeenCalled();
    await act(async () => chat.resolve(0));
    await settle();
    expect(workspaceOpened()).toBe(false);
    expect(testState.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps the question when the start fails, and Try again starts afresh", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    testState.workspace.newChat.mockRejectedValueOnce(new Error("Model is disabled"));
    arrive("https://home.principlesvc.app/");
    await renderStart(QUESTION);
    await settle();

    expect(bubble()?.textContent).toBe(QUESTION);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Couldn't start this chat.");
    expect(text()).not.toContain("Thinking");
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(workspaceOpened()).toBe(false);
    expect(testState.dispose).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("Failed to create gadget:", expect.any(Error));

    await act(async () => tryAgain().click());
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(text()).toContain("Thinking");
    await settle();

    expect(testState.newWorkspace).toHaveBeenCalledTimes(2);
    expect(testState.workspace.newChat).toHaveBeenCalledTimes(2);
    expect(testState.navigate).toHaveBeenCalledWith(TO_WORKSPACE);
  });

  it("shows the failure when the models do not load, without sending", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    testState.listModels.mockRejectedValue(new Error("Models unavailable"));
    arrive("https://home.principlesvc.app/");
    await renderStart(QUESTION);
    await settle();

    expect(testState.workspace.newChat).not.toHaveBeenCalled();
    expect(bubble()?.textContent).toBe(QUESTION);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Couldn't start this chat.");
    expect(testState.dispose).toHaveBeenCalledTimes(1);
    expect(workspaceOpened()).toBe(false);
  });

  it("opens the chat it already started, not another, when Try again follows a failed move", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    testState.navigate.mockRejectedValueOnce(new Error("Navigation interrupted"));
    arrive("https://home.principlesvc.app/");
    await renderStart(QUESTION);
    await settle();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();

    await act(async () => tryAgain().click());
    await settle();
    expect(testState.workspace.newChat).toHaveBeenCalledTimes(1);
    expect(testState.navigate).toHaveBeenCalledTimes(2);
    expect(testState.navigate).toHaveBeenLastCalledWith(TO_WORKSPACE);
  });

  it.each([
    ["opened from anywhere but home", () => arrive("https://evil.example/")],
    ["reloaded", () => arrive("https://home.principlesvc.app/", OPENED_FOR_QUESTION, "reload")],
    ["visited directly", () => arrive("https://home.principlesvc.app/", `https://dispatch.principlesvc.app${START_ADDRESS}`)],
  ])("only fills the home composer when /start was %s", async (_case, open) => {
    open();
    await renderStart(QUESTION);
    await settle();

    expect(testState.navigate).toHaveBeenCalledWith(BACK_HOME);
    expect(testState.newWorkspace).not.toHaveBeenCalled();
    expect(testState.listModels).not.toHaveBeenCalled();
    expect(bubble()).toBeNull();
  });

  it("starts once per page: coming back to /start only fills the home composer", async () => {
    arrive("https://home.principlesvc.app/");
    await renderStart(QUESTION);
    await settle();
    await leave();
    testState.navigate.mockClear();

    await renderStart(QUESTION);
    await settle();
    expect(testState.workspace.newChat).toHaveBeenCalledTimes(1);
    expect(testState.navigate).toHaveBeenCalledWith(BACK_HOME);
  });

  it("says it is still starting once the start has taken eight seconds", async () => {
    vi.useFakeTimers();
    testState.listModels.mockImplementation(() => new Promise(() => {}));
    arrive("https://home.principlesvc.app/");
    await renderStart(QUESTION);

    await act(async () => { vi.advanceTimersByTime(7_999); });
    expect(text()).not.toContain("Still starting");
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Still starting");
    expect(text()).toContain("Thinking");
  });

  it("counts the eight seconds from the start, though its API is replaced on the way", async () => {
    vi.useFakeTimers();
    testState.listModels.mockImplementation(() => new Promise(() => {}));
    arrive("https://home.principlesvc.app/");
    await renderStart(QUESTION);

    await act(async () => { vi.advanceTimersByTime(5_000); });
    testState.authenticatedApi = { ...testState.authenticatedApi };
    await rerenderStart(QUESTION);
    await act(async () => { vi.advanceTimersByTime(3_000); });
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Still starting");
    expect(testState.newWorkspace).toHaveBeenCalledTimes(1);
  });
});

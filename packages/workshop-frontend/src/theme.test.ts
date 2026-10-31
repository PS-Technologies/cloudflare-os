// @vitest-environment jsdom

// Principle: the three themes and the `ps-theme` cookie the home page shares with Dispatch.

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyThemeMode, readThemeMode, resolveTheme, themeCookie } from "./theme";

function prefersDark(dark: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: dark && query === "(prefers-color-scheme: dark)",
  }) as MediaQueryList);
}

function clearCookies() {
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}

afterEach(() => {
  clearCookies();
  vi.unstubAllGlobals();
});

describe("themeCookie", () => {
  const live = { hostname: "dispatch.principlesvc.app", protocol: "https:" };

  it("shares a choice with every principlesvc.app host for a year", () => {
    expect(themeCookie("charcoal", live))
      .toBe("ps-theme=charcoal; Path=/; Max-Age=31536000; SameSite=Lax; Domain=principlesvc.app; Secure");
  });

  it("keeps a choice to this host off principlesvc.app, and drops Secure on http", () => {
    expect(themeCookie("dark", { hostname: "localhost", protocol: "http:" }))
      .toBe("ps-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax");
    expect(themeCookie("light", { hostname: "principlesvc.app.evil.example", protocol: "https:" }))
      .not.toContain("Domain=");
  });

  it("clears the saved choice when the system decides", () => {
    expect(themeCookie("system", live))
      .toBe("ps-theme=; Path=/; Max-Age=0; SameSite=Lax; Domain=principlesvc.app; Secure");
  });
});

describe("readThemeMode", () => {
  it("reads the theme the cookie saved, among other cookies", () => {
    document.cookie = "other=1";
    document.cookie = "ps-theme=charcoal";
    expect(readThemeMode()).toBe("charcoal");
  });

  it("follows the system when nothing, or nothing it knows, is saved", () => {
    expect(readThemeMode()).toBe("system");
    document.cookie = "ps-theme=system";
    expect(readThemeMode()).toBe("system");
    document.cookie = "ps-theme=sepia";
    expect(readThemeMode()).toBe("system");
    clearCookies();
    document.cookie = "not-ps-theme=dark";
    expect(readThemeMode()).toBe("system");
  });
});

describe("resolveTheme and applyThemeMode", () => {
  it("draws charcoal when the system is dark and light when it is not", () => {
    prefersDark(true);
    expect(resolveTheme("system")).toBe("charcoal");
    prefersDark(false);
    expect(resolveTheme("system")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("sets the theme brand draws, and the light or dark half Kumo reads", () => {
    const root = document.documentElement;
    expect(applyThemeMode("charcoal")).toBe("dark");
    expect([root.dataset.theme, root.dataset.mode, root.style.colorScheme]).toEqual(["charcoal", "dark", "dark"]);
    expect(applyThemeMode("dark")).toBe("dark");
    expect([root.dataset.theme, root.dataset.mode]).toEqual(["dark", "dark"]);
    expect(applyThemeMode("light")).toBe("light");
    expect([root.dataset.theme, root.dataset.mode, root.style.colorScheme]).toEqual(["light", "light", "light"]);
  });
});

import { describe, expect, it } from "vitest";
import { handedOverFromHome } from "./homePrompt";

const opened = (search: Record<string, string>, type: NavigationTimingType = "navigate") => ({
  name: `https://dispatch.principlesvc.app/?${new URLSearchParams(search)}`,
  type,
});

describe("handedOverFromHome", () => {
  const fromHome = {
    referrer: "https://home.principlesvc.app/",
    arrival: opened({ prompt: JSON.stringify("Summarize LCRA"), send: "1" }),
    dev: false,
  };

  it("sends a prompt home handed over, opened fresh at the address that asked to send it", () => {
    expect(handedOverFromHome("Summarize LCRA", fromHome)).toBe(true);
    expect(handedOverFromHome("Summarize LCRA",
      { ...fromHome, arrival: opened({ prompt: "  Summarize LCRA ", send: "1" }) })).toBe(true);
  });

  it("only fills the composer when the page came from anywhere but home", () => {
    for (const referrer of ["", "https://dispatch.principlesvc.app/", "https://home.principlesvc.app.evil.example/",
      "http://home.principlesvc.app/", "https://evil.example/?https://home.principlesvc.app/"]) {
      expect(handedOverFromHome("Summarize LCRA", { ...fromHome, referrer })).toBe(false);
    }
  });

  it("trusts home running locally only in a development build", () => {
    const local = { ...fromHome, referrer: "http://localhost:3020/" };
    expect(handedOverFromHome("Summarize LCRA", local)).toBe(false);
    expect(handedOverFromHome("Summarize LCRA", { ...local, dev: true })).toBe(true);
    expect(handedOverFromHome("Summarize LCRA", { ...local, referrer: "http://localhost:3021/", dev: true }))
      .toBe(false);
  });

  it("does not send on a reload, on back, or without an opening address", () => {
    const asked = { prompt: JSON.stringify("Summarize LCRA"), send: "1" };
    expect(handedOverFromHome("Summarize LCRA", { ...fromHome, arrival: opened(asked, "reload") })).toBe(false);
    expect(handedOverFromHome("Summarize LCRA", { ...fromHome, arrival: opened(asked, "back_forward") }))
      .toBe(false);
    expect(handedOverFromHome("Summarize LCRA", { ...fromHome, arrival: undefined })).toBe(false);
  });

  it("does not send a prompt the opening address did not ask to send", () => {
    // A link inside the app keeps home as the referrer, but the page was opened for another question.
    expect(handedOverFromHome("Something else", fromHome)).toBe(false);
    expect(handedOverFromHome("Summarize LCRA",
      { ...fromHome, arrival: opened({ prompt: JSON.stringify("Summarize LCRA") }) })).toBe(false);
    expect(handedOverFromHome("Summarize LCRA",
      { ...fromHome, arrival: opened({ prompt: JSON.stringify("Summarize LCRA"), send: "true" }) })).toBe(false);
    expect(handedOverFromHome("Summarize LCRA", {
      ...fromHome,
      arrival: { ...opened({ prompt: JSON.stringify("Summarize LCRA"), send: "1" }),
        name: "https://dispatch.principlesvc.app/workspace/abc?prompt=%22Summarize%20LCRA%22&send=1" },
    })).toBe(false);
    expect(handedOverFromHome(undefined, fromHome)).toBe(false);
  });
});

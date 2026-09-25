// The Browser pane's two server-side decisions: which connection is the workspace's browser, and
// what opaque key names the viewer. Both must come from the workspace's own records, never from
// the client, so the browser gatekeeper can match a viewer against the handoff it started.

import { describe, expect, it } from "vitest";
import { browserPaneControllerId, findAmbientBrowserGatekeeper } from "../src/overseer.js";

describe("findAmbientBrowserGatekeeper", () => {
  it("picks the ambient Browser Run capsule by vendor id, ignoring other connections", () => {
    let records = [
      {id: 3, creationSpec: {type: "gatekeeper" as const, vendorId: "browser", resourceUrl: "https://x", typeUrlPattern: "https://x"}},
      {id: 4, creationSpec: {type: "ambient" as const, vendorId: "context", accountId: 1}},
      {id: 5, creationSpec: {type: "ambient" as const, vendorId: "Browser", accountId: 2}},
      {id: 6, creationSpec: {type: "ambient" as const, vendorId: "browser", accountId: 3}},
    ];
    expect(findAmbientBrowserGatekeeper(records)?.id).toBe(5);
  });

  it("finds nothing in a workspace without a browser, including legacy records", () => {
    expect(findAmbientBrowserGatekeeper([])).toBeUndefined();
    expect(findAmbientBrowserGatekeeper([{id: 1, creationSpec: undefined}])).toBeUndefined();
    expect(findAmbientBrowserGatekeeper([
      {id: 2, creationSpec: {type: "ambient" as const, vendorId: "context", accountId: 1}},
    ])).toBeUndefined();
  });
});

describe("browserPaneControllerId", () => {
  it("keys the owner as owner and a collaborator by their addObserver id", () => {
    expect(browserPaneControllerId(true, undefined)).toBe("owner");
    expect(browserPaneControllerId(true, "obs-1")).toBe("owner");
    expect(browserPaneControllerId(false, "obs-1")).toBe("observer:obs-1");
  });

  it("gives a collaborator with no observer record no key at all", () => {
    expect(browserPaneControllerId(false, undefined)).toBeUndefined();
  });
});

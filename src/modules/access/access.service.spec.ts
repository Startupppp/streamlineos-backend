import { broadest, isInternalModule, moduleOf } from "./access.service";
import type { DataScope } from "./access.types";

describe("broadest", () => {
  it("ranks none < own < team < all", () => {
    expect(broadest("none", "own")).toBe("own");
    expect(broadest("own", "team")).toBe("team");
    expect(broadest("team", "all")).toBe("all");
    expect(broadest("none", "all")).toBe("all");
  });

  it("keeps the broader scope regardless of argument order", () => {
    expect(broadest("all", "own")).toBe("all");
    expect(broadest("own", "all")).toBe("all");
  });

  it("returns the same scope when both are equal", () => {
    const scopes: DataScope[] = ["none", "own", "team", "all"];
    for (const scope of scopes) expect(broadest(scope, scope)).toBe(scope);
  });
});

describe("moduleOf", () => {
  it("extracts the part before the first colon", () => {
    expect(moduleOf("hr:employees:view")).toBe("hr");
    expect(moduleOf("settings:rbac:manage")).toBe("settings");
  });

  it("returns the whole key when there is no colon", () => {
    expect(moduleOf("accounting")).toBe("accounting");
  });
});

describe("isInternalModule", () => {
  it("treats settings and self as internal", () => {
    expect(isInternalModule("settings")).toBe(true);
    expect(isInternalModule("self")).toBe(true);
  });

  it("treats feature modules as non-internal", () => {
    expect(isInternalModule("hr")).toBe(false);
    expect(isInternalModule("crm")).toBe(false);
  });
});

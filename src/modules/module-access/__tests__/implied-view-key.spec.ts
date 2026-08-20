import { impliedViewKey } from "../module-access.service";

const catalog = new Set([
  "surveys:view",
  "surveys:create",
  "hr:employees:view",
  "hr:employees:update",
  "tasks:read",
  "tasks:write",
  "build:workspaces:members:view",
  "build:workspaces:members:manage",
  "payroll:runs:post",
]);

describe("impliedViewKey", () => {
  it("derives the sibling view key for a three-segment write", () => {
    expect(impliedViewKey(catalog, "hr:employees:update")).toBe(
      "hr:employees:view",
    );
  });

  it("derives it for a two-segment write, which the previous positional parse skipped", () => {
    expect(impliedViewKey(catalog, "surveys:create")).toBe("surveys:view");
  });

  it("derives it for a four-segment write", () => {
    expect(impliedViewKey(catalog, "build:workspaces:members:manage")).toBe(
      "build:workspaces:members:view",
    );
  });

  it("accepts read as the view verb where a module uses that convention", () => {
    expect(impliedViewKey(catalog, "tasks:write")).toBe("tasks:read");
  });

  it("returns null for a key that is already a view", () => {
    expect(impliedViewKey(catalog, "hr:employees:view")).toBeNull();
    expect(impliedViewKey(catalog, "tasks:read")).toBeNull();
  });

  it("returns null when the module exposes no matching read key", () => {
    expect(impliedViewKey(catalog, "payroll:runs:post")).toBeNull();
  });

  it("returns null for a single-segment key", () => {
    expect(impliedViewKey(catalog, "settings")).toBeNull();
  });
});

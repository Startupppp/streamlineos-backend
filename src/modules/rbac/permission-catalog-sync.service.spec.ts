import { classifyRetiredPermissions } from "./permission-catalog-sync.service";

describe("classifyRetiredPermissions", () => {
  it("deletes only stale keys without persisted role grants", () => {
    expect(
      classifyRetiredPermissions(
        ["legacy:unused:view", "legacy:assigned:view"],
        ["legacy:assigned:view"],
      ),
    ).toEqual({
      deletableKeys: ["legacy:unused:view"],
      retainedKeys: ["legacy:assigned:view"],
    });
  });

  it("keeps cleanup deterministic for audit output", () => {
    expect(
      classifyRetiredPermissions(
        ["z:resource:view", "a:resource:view"],
        [],
      ),
    ).toEqual({
      deletableKeys: ["a:resource:view", "z:resource:view"],
      retainedKeys: [],
    });
  });
});

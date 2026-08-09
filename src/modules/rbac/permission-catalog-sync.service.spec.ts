import { classifyRetiredPermissions } from "./permission-catalog-sync.service";

describe("classifyRetiredPermissions", () => {
  it("deletes only stale keys without persisted role or delegation grants", () => {
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

  it("retains every referenced key regardless of which grant source found it", () => {
    expect(
      classifyRetiredPermissions(
        ["legacy:role:view", "legacy:delegated:view", "legacy:unused:view"],
        ["legacy:role:view", "legacy:delegated:view"],
      ),
    ).toEqual({
      deletableKeys: ["legacy:unused:view"],
      retainedKeys: ["legacy:delegated:view", "legacy:role:view"],
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

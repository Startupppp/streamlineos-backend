import { entityChannelFallbackName } from "./chat-channels.service";

describe("entityChannelFallbackName", () => {
  it("builds the placeholder used before a record's title is known", () => {
    expect(entityChannelFallbackName("project", "42")).toBe("Project: 42");
    expect(entityChannelFallbackName("task", "7")).toBe("Task: 7");
  });

  /**
   * The rename repair only overwrites a name that still matches this
   * placeholder, so a name a human chose must never collide with it.
   */
  it("does not collide with a human-readable channel name", () => {
    expect(entityChannelFallbackName("project", "42")).not.toBe(
      "Website relaunch",
    );
  });
});

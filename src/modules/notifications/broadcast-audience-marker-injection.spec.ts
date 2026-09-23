import { createBroadcastSchema, updateBroadcastSchema } from "./dto/broadcast.schemas";

const BASE = {
  title: "Quarterly update",
  message: "Body",
};

describe("the admin broadcast surface cannot forge the org-announcement marker", () => {
  it("strips orgAnnouncement from an all audience so a forged marker never reaches the column", () => {
    const parsed = createBroadcastSchema.parse({
      ...BASE,
      audience: { type: "all", orgAnnouncement: { targetType: "ALL", targetIds: [] } },
    });

    expect(parsed.audience).toEqual({ type: "all" });
  });

  it("strips orgAnnouncement from a users audience too", () => {
    const parsed = createBroadcastSchema.parse({
      ...BASE,
      audience: {
        type: "users",
        userIds: ["u1"],
        orgAnnouncement: { targetType: "BRANCH", targetIds: ["b1"] },
      },
    });

    expect(parsed.audience).toEqual({ type: "users", userIds: ["u1"] });
  });

  it("strips orgAnnouncement on update, which is the path that could retarget an existing row", () => {
    const parsed = updateBroadcastSchema.parse({
      audience: { type: "all", orgAnnouncement: { targetType: "ALL", targetIds: [] } },
    });

    expect(parsed.audience).toEqual({ type: "all" });
  });

  it("accepts a legitimate audience unchanged, so the assertions above are not vacuous", () => {
    const parsed = createBroadcastSchema.parse({
      ...BASE,
      audience: { type: "roles", roleIds: ["r1"] },
    });

    expect(parsed.audience).toEqual({ type: "roles", roleIds: ["r1"] });
  });

  it("still rejects an unknown key at the top level, where the schema is strict", () => {
    const result = createBroadcastSchema.safeParse({
      ...BASE,
      audience: { type: "all" },
      orgAnnouncement: { targetType: "ALL" },
    });

    expect(result.success).toBe(false);
  });
});

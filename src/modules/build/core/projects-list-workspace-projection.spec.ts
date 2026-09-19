import { projectListItemSchema } from "./dto/build-core-response.schemas";

describe("projectListItemSchema — the workspace dimension the selector nests on", () => {
  const validItem = {
    id: 1,
    name: "Billing",
    description: null,
    key: "BIL",
    status: "ACTIVE",
    priority: null,
    startDate: null,
    endDate: null,
    managedProductId: null,
    pmWorkspaceId: "ws-1",
    manager: null,
    progress: { total: 0, done: 0, percentage: 0 },
    health: "on_track",
    members: [],
    teams: [],
  };

  it("carries pmWorkspaceId so a standalone project can be nested under its workspace", () => {
    const parsed = projectListItemSchema.parse(validItem);
    expect(parsed.pmWorkspaceId).toBe("ws-1");
  });

  it("rejects a row whose pmWorkspaceId is missing rather than silently dropping the nesting key", () => {
    const { pmWorkspaceId: _omitted, ...withoutWorkspace } = validItem;
    expect(() => projectListItemSchema.parse(withoutWorkspace)).toThrow();
  });

  it("rejects a null pmWorkspaceId because the column is NOT NULL", () => {
    expect(() =>
      projectListItemSchema.parse({ ...validItem, pmWorkspaceId: null }),
    ).toThrow();
  });
});

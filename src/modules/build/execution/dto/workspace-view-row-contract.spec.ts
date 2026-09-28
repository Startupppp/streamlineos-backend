import { projectViews } from "../../../../db/schema";
import { viewLayoutEnum } from "../../../../db/schema/common/enums";
import { viewRowSchema } from "./workspace-response.schemas";

const VIEW_ROW = {
  id: 1,
  projectId: null,
  orgId: "org-1",
  createdBy: "user-1",
  name: "My board",
  filters: {},
  groupBy: null,
  orderBy: null,
  layoutType: "board",
  isPinned: false,
  visibility: "shared",
  displayOptions: {},
  scope: "workspace",
  createdAt: new Date("2026-09-28T00:00:00.000Z"),
  updatedAt: new Date("2026-09-28T00:00:00.000Z"),
};

describe("viewRowSchema matches the project_views columns it projects", () => {
  it("accepts the row shape listWorkspaceViews returns, so the rejections below are attributable to the field under test", () => {
    expect(viewRowSchema.safeParse(VIEW_ROW).success).toBe(true);
  });

  it.each(["createdBy", "visibility", "scope"] as const)(
    "declares %s non-nullable, because the column is NOT NULL and a nullable contract makes the frontend reject a row the database can always supply",
    (field) => {
      expect(projectViews[field].notNull).toBe(true);
      expect(viewRowSchema.safeParse({ ...VIEW_ROW, [field]: null }).success).toBe(
        false,
      );
    },
  );

  it("keeps projectId nullable, because a workspace-scoped view belongs to no project", () => {
    expect(projectViews.projectId.notNull).toBe(false);
    expect(viewRowSchema.safeParse({ ...VIEW_ROW, projectId: null }).success).toBe(
      true,
    );
  });

  it("accepts every layout the view_layout enum can hold and rejects one it cannot, so the contract cannot drift from the database enum", () => {
    for (const layout of viewLayoutEnum.enumValues) {
      expect(
        viewRowSchema.safeParse({ ...VIEW_ROW, layoutType: layout }).success,
      ).toBe(true);
    }
    expect(
      viewRowSchema.safeParse({ ...VIEW_ROW, layoutType: "timeline" }).success,
    ).toBe(false);
  });

  it("rejects a visibility the create and update bodies cannot produce, where a bare string would pass it through to a frontend enum that throws", () => {
    expect(
      viewRowSchema.safeParse({ ...VIEW_ROW, visibility: "public" }).success,
    ).toBe(false);
  });

  it("rejects a scope outside the two the services set, because listWorkspaceViews filters on scope and a third value would be invisible everywhere", () => {
    expect(viewRowSchema.safeParse({ ...VIEW_ROW, scope: "team" }).success).toBe(
      false,
    );
  });
});

import {
  projectAutomationListItemSchema,
  projectReleaseRowSchema,
} from "./dto/build-core-response.schemas";
import { releaseRowWithCount } from "./projects-releases.service";

describe("the automations list answers every field its card renders", () => {
  it("declares projectId, conditions and actions", () => {
    const shape = projectAutomationListItemSchema.shape;

    expect(Object.keys(shape)).toEqual(
      expect.arrayContaining(["projectId", "conditions", "actions"]),
    );
  });
});

describe("releaseRowWithCount", () => {
  const ROW = {
    id: 5,
    orgId: "org-1",
    projectId: 3,
    name: "v1.2",
    version: "1.2.0",
    description: null,
    status: "draft" as const,
    releaseDate: null,
    rowVersion: 1,
    createdBy: "user-1",
    deletedAt: null,
    createdAt: new Date("2026-09-15T10:00:00.000Z"),
    updatedAt: new Date("2026-09-15T10:00:00.000Z"),
  };

  it("reports zero for a release nothing has been assigned to yet", () => {
    expect(releaseRowWithCount(ROW, 0).ticketCount).toBe(0);
  });

  it("reports the count it is given", () => {
    expect(releaseRowWithCount(ROW, 7).ticketCount).toBe(7);
  });

  it("satisfies the declared release response schema", () => {
    expect(() => projectReleaseRowSchema.parse(releaseRowWithCount(ROW, 0))).not.toThrow();
  });
});

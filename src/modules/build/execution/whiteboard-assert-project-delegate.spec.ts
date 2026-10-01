import { NotFoundException } from "@nestjs/common";
import * as projectAccess from "../core/project-crud/project-access";
import { assertProject } from "./whiteboard-board-helpers";

describe("whiteboard-board-helpers assertProject — re-exports assertProjectInOrg", () => {
  it("is the same reference as assertProjectInOrg from canonical project-access", () => {
    expect(assertProject).toBe(projectAccess.assertProjectInOrg);
  });

  it("propagates NotFoundException from assertProjectInOrg when project is absent", async () => {
    const db = { query: { projects: { findFirst: jest.fn().mockResolvedValue(undefined) } } };
    await expect(assertProject(db as never, "org-1", 99)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("resolves silently when project exists in org (control)", async () => {
    const db = { query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } } };
    await expect(assertProject(db as never, "org-1", 1)).resolves.toBeUndefined();
  });
});

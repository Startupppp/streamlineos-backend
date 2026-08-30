import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { WorkflowService } from "./workflow.service";

describe("WorkflowService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const audit = { log: jest.fn() } as never;

  function makeDb(projectRow: unknown | null, transitionRows: unknown[]) {
    const limit = jest.fn().mockResolvedValue(transitionRows);
    const where = jest.fn().mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    return {
      db: {
        query: { projects: { findFirst: jest.fn().mockResolvedValue(projectRow) } },
        select,
      } as unknown as Db,
    };
  }

  it("throws NotFoundException for listTransitions when project not in org (cross-tenant isolation)", async () => {
    const { db } = makeDb(null, []);
    const svc = new WorkflowService(db, audit);
    await expect(svc.listTransitions(ATTACKER_ORG, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns transitions for the owning org (same-tenant control)", async () => {
    const project = { id: 1, orgId: OWNER_ORG };
    const transition = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "Start" };
    const { db } = makeDb(project, [transition]);
    const svc = new WorkflowService(db, audit);
    const result = await svc.listTransitions(OWNER_ORG, 1);
    expect(result).toHaveLength(1);
  });
});

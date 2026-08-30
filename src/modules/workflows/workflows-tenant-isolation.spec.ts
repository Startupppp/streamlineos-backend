import type { Db } from "../../db/drizzle.module";
import { WorkflowsService } from "./workflows.service";

describe("WorkflowsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  const makeQuery = () => ({ page: 1, limit: 20 });

  function makeCrud() {
    return {
      listWorkflows: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 }),
      getWorkflow: jest.fn().mockResolvedValue(null),
    } as never;
  }

  function makeExecution() {
    return {
      triggerWorkflow: jest.fn().mockResolvedValue({}),
      listExecutions: jest.fn().mockResolvedValue([]),
    } as never;
  }

  it("passes the requesting org to the crud layer (tenant isolation)", async () => {
    const crud = makeCrud();
    const svc = new WorkflowsService({} as unknown as Db, crud, makeExecution());

    await svc.listWorkflows(ATTACKER, makeQuery());

    expect(crud.listWorkflows).toHaveBeenCalledWith(ATTACKER, expect.anything());
    expect(crud.listWorkflows).not.toHaveBeenCalledWith(OWNER, expect.anything());
  });

  it("returns workflows for the owning org (same-tenant control)", async () => {
    const crud = makeCrud();
    const svc = new WorkflowsService({} as unknown as Db, crud, makeExecution());

    const result = await svc.listWorkflows(OWNER, makeQuery());

    expect(result).toBeDefined();
    expect(crud.listWorkflows).toHaveBeenCalledWith(OWNER, expect.anything());
  });
});

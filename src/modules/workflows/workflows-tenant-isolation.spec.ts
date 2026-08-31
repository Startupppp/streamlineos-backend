import { WorkflowsService } from "./workflows.service";

describe("WorkflowsService — cross-tenant isolation (delegation)", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeCrud() {
    return {
      listWorkflows: jest.fn().mockResolvedValue({ data: [], pagination: { nextCursor: null, hasMore: false } }),
      getWorkflow: jest.fn().mockResolvedValue(null),
    };
  }

  function makeExecution() {
    return {
      triggerWorkflow: jest.fn().mockResolvedValue({}),
      listExecutions: jest.fn().mockResolvedValue({ data: [], pagination: { nextCursor: null, hasMore: false } }),
    } as never;
  }

  function makeSchedules() {
    return { listAllSchedules: jest.fn().mockResolvedValue([]) } as never;
  }

  function makeSecrets() {
    return { listGlobalSecrets: jest.fn().mockResolvedValue([]) } as never;
  }

  function makeVariables() {
    return { listGlobalVariables: jest.fn().mockResolvedValue([]) } as never;
  }

  function makeAnalytics() {
    return {
      getAnalytics: jest.fn().mockResolvedValue({
        totalWorkflows: 0,
        activeWorkflows: 0,
        totalExecutions: 0,
        successRate: 0,
        avgDuration: 0,
        pendingApprovals: 0,
        executionTrend: [],
      }),
    } as never;
  }

  it("passes the requesting org to the crud layer (tenant isolation)", async () => {
    const crud = makeCrud();
    const svc = new WorkflowsService(crud as never, makeExecution(), makeSchedules(), makeSecrets(), makeVariables(), makeAnalytics());

    await svc.listWorkflows(ATTACKER, { cursor: undefined, limit: 20, sort: "createdAt", direction: "desc" });

    expect(crud.listWorkflows).toHaveBeenCalledWith(ATTACKER, expect.anything());
    expect(crud.listWorkflows).not.toHaveBeenCalledWith(OWNER, expect.anything());
  });

  it("returns workflows for the owning org (same-tenant control)", async () => {
    const crud = makeCrud();
    const svc = new WorkflowsService(crud as never, makeExecution(), makeSchedules(), makeSecrets(), makeVariables(), makeAnalytics());

    const result = await svc.listWorkflows(OWNER, { cursor: undefined, limit: 20, sort: "createdAt", direction: "desc" });

    expect(result).toBeDefined();
    expect(crud.listWorkflows).toHaveBeenCalledWith(OWNER, expect.anything());
  });
});

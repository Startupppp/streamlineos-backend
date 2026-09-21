import type { Db } from "../../../../db/drizzle.module";
import { HrWorkflowDefinitionsService } from "../hr-workflow-definitions.service";
import type { HrWorkflowEngineService } from "../hr-workflow-engine.service";
import type { HrWorkflowApproverService } from "../hr-workflow-approver.service";
import { workflowDefinitionListSchema } from "../dto/workflow-response.schemas";

const DEFINITION_ROW = {
  id: 7,
  orgId: "org-1",
  objectType: "leave_request",
  name: "Leave approval",
  status: "active",
  version: 1,
  isDefault: true,
  settings: { rejectionCommentRequired: true },
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  deletedAt: null,
};

function makeDb(definitionRows: unknown[], stepCountRows: unknown[]) {
  const definitionChain: Record<string, jest.Mock> = {};
  for (const method of ["from", "where", "orderBy"])
    definitionChain[method] = jest.fn().mockReturnValue(definitionChain);
  definitionChain.limit = jest.fn().mockResolvedValue(definitionRows);

  const stepChain: Record<string, jest.Mock> = {};
  for (const method of ["from", "where"])
    stepChain[method] = jest.fn().mockReturnValue(stepChain);
  stepChain.groupBy = jest.fn().mockResolvedValue(stepCountRows);

  const select = jest
    .fn()
    .mockReturnValueOnce(definitionChain)
    .mockReturnValueOnce(stepChain);
  return { db: { select } as unknown as Db, select };
}

describe("GET /hr/workflows list rows satisfy the declared response contract", () => {
  function makeService(definitionRows: unknown[], stepCountRows: unknown[]) {
    const { db, select } = makeDb(definitionRows, stepCountRows);
    const service = new HrWorkflowDefinitionsService(
      db,
      {} as unknown as HrWorkflowEngineService,
      {} as unknown as HrWorkflowApproverService,
    );
    return { service, select };
  }

  it("projects settings on every row so the list parses under workflowDefinitionListSchema", async () => {
    const { service, select } = makeService(
      [DEFINITION_ROW],
      [{ definitionId: 7, cnt: 2 }],
    );

    const result = await service.list("org-1", { limit: 50 });
    const parsed = workflowDefinitionListSchema.safeParse(result);

    expect(parsed.success).toBe(true);
    expect(result.data[0]?.settings).toEqual({ rejectionCommentRequired: true });
    expect(result.data[0]?.stepCount).toBe(2);
    const projection = select.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(projection)).toContain("settings");
  });

  it("returns a cursor page, never an offset page", async () => {
    const { service } = makeService([DEFINITION_ROW], []);

    const result = await service.list("org-1", { limit: 50 });

    expect(result.pagination).toEqual({ limit: 50, hasMore: false, nextCursor: null });
    expect(result).not.toHaveProperty("page");
    expect(result).not.toHaveProperty("total");
  });
});

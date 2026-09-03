import type { Db } from "../../../../db/drizzle.module";
import { HrWorkflowApproverService } from "../hr-workflow-approver.service";
import type { AccessService } from "../../../access/access.service";
import type { EmploymentFactsService } from "../../../directory/employment-facts.service";
import type { ResolvedStep } from "../hr-workflow-engine.types";

function makeDeptHeadSelectChain(rows: unknown[]) {
  const where = jest.fn();
  const chain: Record<string, unknown> = {
    from: jest.fn(),
    where,
    limit: jest.fn(),
    leftJoin: jest.fn(),
  };
  for (const k of ["from", "where", "limit", "leftJoin"])
    (chain[k] as jest.Mock).mockReturnValue(chain);
  where.mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) });
  return { chain, where };
}

describe("HrWorkflowApproverService.resolveApprovers — soft-delete predicate on department_head", () => {
  const ORG = "org-1";
  const SUBJECT = "user-subject";
  const DEPT_ID = "dept-deleted";
  const STEP: ResolvedStep = { stepOrder: 1, name: "Dept Head", approverType: "department_head", approverValue: null, mode: "sequential" };

  function makeService(deptRows: unknown[]) {
    const { chain } = makeDeptHeadSelectChain(deptRows);
    const db = {
      select: jest.fn().mockReturnValue(chain),
    } as unknown as Db;
    const access = {} as unknown as AccessService;
    const employment = {
      getFacts: jest.fn().mockResolvedValue({ departmentId: DEPT_ID, managerUserId: null }),
    } as unknown as EmploymentFactsService;
    return new HrWorkflowApproverService(db, access, employment);
  }

  it("returns empty when department is soft-deleted (DB returns no dept row)", async () => {
    const svc = makeService([]);
    const result = await svc.resolveApprovers(STEP, SUBJECT, ORG);
    expect(result).toEqual([]);
  });

  it("returns head user when department is live", async () => {
    const svc = makeService([{ headUserId: "manager-1" }]);
    const result = await svc.resolveApprovers(STEP, SUBJECT, ORG);
    expect(result).toEqual(["manager-1"]);
  });
});

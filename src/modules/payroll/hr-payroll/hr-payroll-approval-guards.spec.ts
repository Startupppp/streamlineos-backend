import { Reflector } from "@nestjs/core";
import type { Db } from "../../../db/drizzle.module";
import { LoansService } from "./loans.service";
import { resolveReimbursementsScope } from "./reimbursements-scope";
import { REQUIRE_PERMISSION } from "../../access/require-permission.decorator";
import { HrPayrollReimbursementsController } from "./reimbursements.controller";
import { LoansController } from "./loans.controller";
import type { ReimbursementsService } from "./reimbursements.service";
import { isScopable } from "../../rbac/permissions";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ORG = "org-1";
const LOAN_ID = 3;
const REQUESTER = "user-requester";

describe("a salary loan cannot be decided by the employee who requested it", () => {
  function makeDb(loanOwnerId: string) {
    const update = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    });
    const db = {
      query: {
        salaryLoans: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: LOAN_ID, orgId: ORG, userId: loanOwnerId, status: "PENDING" }),
        },
      },
      update,
      transaction: jest.fn().mockImplementation(async (fn: (t: unknown) => Promise<unknown>) =>
        fn({ update, insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }) }),
      ),
    } as unknown as Db;
    return { db, update };
  }

  it("returns own_request and writes nothing when the requester decides their own loan", async () => {
    const { db, update } = makeDb(REQUESTER);
    const svc = new LoansService(db);

    const result = await svc.updateLoan(ORG, REQUESTER, LOAN_ID, { status: "APPROVED" });

    expect(result).toEqual({ ok: false, reason: "own_request" });
    expect(update).not.toHaveBeenCalled();
  });

  it("allows a different approver to decide the loan", async () => {
    const { db, update } = makeDb("someone-else");
    const svc = new LoansService(db);

    const result = await svc.updateLoan(ORG, "user-approver", LOAN_ID, { status: "APPROVED" });

    expect(result).toEqual({ ok: true });
    expect(update).toHaveBeenCalled();
  });

  it("distinguishes a missing loan from a self decision", async () => {
    const db = {
      query: { salaryLoans: { findFirst: jest.fn().mockResolvedValue(undefined) } },
    } as unknown as Db;

    const result = await new LoansService(db).updateLoan(ORG, REQUESTER, LOAN_ID, {
      status: "APPROVED",
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("the reimbursements list scope comes from the key that gates the route", () => {
  const routeKey = new Reflector().get<string>(
    REQUIRE_PERMISSION,
    HrPayrollReimbursementsController.prototype.list,
  );

  it("the list handler declares a permission at all", () => {
    expect(typeof routeKey).toBe("string");
  });

  it("resolves scope from the same permission the list endpoint requires", async () => {
    const resolveUserPermissions = jest.fn().mockResolvedValue(new Map([[routeKey, "own"]]));
    const user: CurrentUserContext = {
      userId: "user-1",
      orgId: "org-1",
      role: "HR",
      isOrgOwner: false,
      sessionId: "session-1",
      tokenScopes: null,
      principal: humanSessionPrincipal(1, false),
    };

    const read = await resolveReimbursementsScope(
      { resolveUserPermissions } as unknown as AccessService,
      user,
    );

    expect(isScopable(routeKey)).toBe(true);
    expect(read.rawScope("spec reads the resolved scope")).toBe("own");
  });
});

// SEC-HRMS-011. Both routes treated hr:expenses:approve at ANY scope as org-wide authority, so a
// manager whose grant is scoped to their team could approve any employee's loan or reimbursement.
describe("a team-scoped expense approver is not an org-wide loan or reimbursement admin", () => {
  const teamApprover = {
    orgId: ORG,
    userId: "user-manager",
    isOrgOwner: false,
    principal: humanSessionPrincipal(7, false),
  } as CurrentUserContext;
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["hr:expenses:approve", "team"]])),
  } as unknown as AccessService;

  it("refuses the loan decision", async () => {
    const loans = { updateLoan: jest.fn() } as unknown as LoansService;
    await expect(
      new LoansController(loans, access).update(LOAN_ID, { status: "APPROVED" }, teamApprover),
    ).rejects.toThrow("Only admins can process loan status changes.");
    expect(loans.updateLoan).not.toHaveBeenCalled();
  });

  it("refuses the reimbursement decision", async () => {
    const reimbursements = { updateStatus: jest.fn() } as unknown as ReimbursementsService;
    await expect(
      new HrPayrollReimbursementsController(reimbursements, access).update(5, { status: "APPROVED" }, teamApprover),
    ).rejects.toThrow("Only admins can process reimbursements.");
    expect(reimbursements.updateStatus).not.toHaveBeenCalled();
  });
});


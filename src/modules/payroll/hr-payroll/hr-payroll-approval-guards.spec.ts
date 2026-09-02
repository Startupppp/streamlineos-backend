import type { Db } from "../../../db/drizzle.module";
import { LoansService } from "./loans.service";
import { REIMBURSEMENTS_PERMISSION } from "./reimbursements-scope";
import { HR_PAYROLL_LIST_PERMISSION } from "./hr-payroll-permissions";

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
  it("resolves scope from the same permission the list endpoint requires", () => {
    expect(REIMBURSEMENTS_PERMISSION).toBe(HR_PAYROLL_LIST_PERMISSION);
  });
});

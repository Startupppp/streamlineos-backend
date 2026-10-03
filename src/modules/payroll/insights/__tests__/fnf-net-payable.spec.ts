import type { Db } from "../../../../db/drizzle.module";
import { FnfService } from "../../hr-payroll/fnf.service";

function serviceCapturingInsert() {
  const values = jest.fn();
  const db = {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ userId: "u1", id: 7 }),
      },
    },
    insert: jest.fn().mockReturnValue({
      values: values.mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 1 }]),
      }),
    }),
  } as unknown as Db;
  return { svc: new FnfService(db), values };
}

async function netPayableFor(input: Omit<Parameters<FnfService["createFnf"]>[1], "userId">) {
  const { svc, values } = serviceCapturingInsert();
  await svc.createFnf("org-1", { userId: "u1", ...input });
  const row = values.mock.calls[0]?.[0] as { netPayable: string; gratuity: string };
  return row;
}

describe("FnfService.createFnf net payable", () => {
  it("adds every earning, gratuity included", async () => {
    const row = await netPayableFor({
      basicDues: 50000,
      leaveEncashment: 10000,
      gratuity: 75000,
      bonusDue: 5000,
      reimbursementsDue: 2000,
    });
    expect(row.netPayable).toBe("142000");
    expect(row.gratuity).toBe("75000");
  });

  it("subtracts every deduction", async () => {
    const row = await netPayableFor({
      basicDues: 100000,
      gratuity: 20000,
      deductions: 5000,
      loanRecovery: 3000,
      assetRecovery: 2000,
      noticeRecovery: 10000,
      otherDeductions: 1000,
    });
    expect(row.netPayable).toBe("99000");
  });

  it("defaults a missing gratuity to zero", async () => {
    const row = await netPayableFor({ basicDues: 50000 });
    expect(row.netPayable).toBe("50000");
    expect(row.gratuity).toBe("0");
  });

  it("can go negative when recoveries exceed earnings", async () => {
    const row = await netPayableFor({ basicDues: 5000, noticeRecovery: 30000 });
    expect(row.netPayable).toBe("-25000");
  });
});

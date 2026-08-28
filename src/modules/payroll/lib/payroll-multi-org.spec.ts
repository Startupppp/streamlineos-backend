import { loadRunEmployeePayees } from "./payroll-run-payee";
import type { EmploymentFactsService } from "../../directory/employment-facts.service";
import type { BankDetails } from "../../directory/employment-facts.types";
import type { EmploymentFacts, SensitiveEmploymentFacts } from "../../directory/employment-facts.types";

const ORG1 = "org-aaa";
const ORG2 = "org-bbb";
const USER_ID = "user-shared-across-orgs";

const bankOrg1: BankDetails = {
  accountNumber: "111111111111",
  bankName: "Bank A",
  branch: "Branch A",
  ifsc: "BKID0000001",
  accountHolder: "Alice",
};

const bankOrg2: BankDetails = {
  accountNumber: "222222222222",
  bankName: "Bank B",
  branch: "Branch B",
  ifsc: "HDFC0000001",
  accountHolder: "Alice",
};

function makeRunEmployeeRow(userId: string) {
  return {
    id: 1,
    userId,
    workerId: null,
    userName: "Alice",
    userEmail: "alice@example.com",
    workerNumber: null,
    personDisplayName: null,
    personFirstName: null,
    personLastName: null,
    personWorkEmail: null,
  };
}

function makeChain(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  return chain;
}

function makeDb(rows: unknown[]) {
  return { select: jest.fn().mockReturnValue(makeChain(rows)) };
}

function makeEfService(orgBankMap: Record<string, BankDetails | null>): EmploymentFactsService {
  return {
    getFactsBatch: jest.fn().mockImplementation((_orgId: string, userIds: string[]) => {
      const map = new Map<string, EmploymentFacts>();
      for (const uid of userIds) {
        map.set(uid, {
          userId: uid,
          employmentId: 1,
          employeeNumber: "EMP001",
          designation: null,
          joiningDate: null,
          departmentId: null,
          locationId: null,
          managerUserId: null,
        });
      }
      return Promise.resolve(map);
    }),
    getSensitiveFactsBatch: jest.fn().mockImplementation((orgId: string, userIds: string[]) => {
      const bank = orgBankMap[orgId] ?? null;
      const map = new Map<string, SensitiveEmploymentFacts>();
      for (const uid of userIds) {
        map.set(uid, {
          userId: uid,
          employmentId: 1,
          salaryAmountCents: orgId === ORG1 ? 100_000 : 200_000,
          bankDetails: bank,
          taxId: orgId === ORG1 ? "ABCDE1234F" : "XYZAB9876P",
        });
      }
      return Promise.resolve(map);
    }),
    getSensitiveFactsByPersonBatch: jest
      .fn()
      .mockImplementation((orgId: string, personIds: string[]) => {
        const bank = orgBankMap[orgId] ?? null;
        const map = new Map<string, SensitiveEmploymentFacts>();
        for (const personId of personIds) {
          map.set(personId, {
            userId: "",
            employmentId: 1,
            salaryAmountCents: orgId === ORG1 ? 100_000 : 200_000,
            bankDetails: bank,
            taxId: orgId === ORG1 ? "ABCDE1234F" : "XYZAB9876P",
          });
        }
        return Promise.resolve(map);
      }),
    getDirectReportUserIds: jest.fn(),
    getFacts: jest.fn(),
    getSensitiveFacts: jest.fn(),
  } as unknown as EmploymentFactsService;
}

describe("payroll multi-org isolation", () => {
  it("returns org1 bank details for org1 and org2 bank details for org2 — same userId", async () => {
    const orgBankMap = { [ORG1]: bankOrg1, [ORG2]: bankOrg2 };

    const efOrg1 = makeEfService(orgBankMap);
    const efOrg2 = makeEfService(orgBankMap);

    const payeesOrg1 = await loadRunEmployeePayees(
      makeDb([makeRunEmployeeRow(USER_ID)]) as never,
      ORG1,
      1,
      efOrg1,
    );
    const payeesOrg2 = await loadRunEmployeePayees(
      makeDb([makeRunEmployeeRow(USER_ID)]) as never,
      ORG2,
      2,
      efOrg2,
    );

    expect(payeesOrg1).toHaveLength(1);
    expect(payeesOrg2).toHaveLength(1);

    expect(payeesOrg1[0]?.bankDetails?.accountNumber).toBe(bankOrg1.accountNumber);
    expect(payeesOrg2[0]?.bankDetails?.accountNumber).toBe(bankOrg2.accountNumber);
    expect(payeesOrg1[0]?.bankDetails?.accountNumber).not.toBe(
      payeesOrg2[0]?.bankDetails?.accountNumber,
    );

    expect(payeesOrg1[0]?.taxId).toBe("ABCDE1234F");
    expect(payeesOrg2[0]?.taxId).toBe("XYZAB9876P");

    expect(efOrg1.getSensitiveFactsBatch).toHaveBeenCalledWith(ORG1, expect.any(Array));
    expect(efOrg2.getSensitiveFactsBatch).toHaveBeenCalledWith(ORG2, expect.any(Array));
  });

  it("passes orgId to getFactsBatch so employment facts are org-scoped", async () => {
    const efService = makeEfService({ [ORG1]: bankOrg1 });

    await loadRunEmployeePayees(
      makeDb([makeRunEmployeeRow(USER_ID)]) as never,
      ORG1,
      1,
      efService,
    );

    expect(efService.getFactsBatch).toHaveBeenCalledWith(ORG1, [USER_ID]);
    expect(efService.getSensitiveFactsBatch).toHaveBeenCalledWith(ORG1, [USER_ID]);
  });
});

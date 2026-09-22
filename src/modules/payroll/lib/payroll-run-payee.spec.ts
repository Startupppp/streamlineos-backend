import * as personSeam from "../../directory/person-seam";
import { loadRunEmployeePayees } from "./payroll-run-payee";
import type { EmploymentFactsService } from "../../directory/employment-facts.service";

jest.mock("../../directory/person-seam");

const ORG = "org-1";
const RUN_ID = 42;

type FakeRow = {
  id: number;
  userId: string | null;
  workerId: string | null;
  userName: string | null;
  userEmail: string | null;
};

function makeEmployee(id: number, userId: string | null = null, workerId: string | null = null): FakeRow {
  return { id, userId, workerId, userName: null, userEmail: null };
}

function makeDb(employeeRows: FakeRow[]) {
  const chain: Record<string, unknown> = {};
  chain["from"] = () => chain;
  chain["leftJoin"] = () => chain;
  chain["where"] = () => chain;
  chain["orderBy"] = () => chain;
  chain["limit"] = jest.fn().mockResolvedValue(employeeRows);
  const query = {
    payrollRunEmployees: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  return { select: jest.fn(() => chain), query } as unknown as import("../../../db/drizzle.module").Db;
}

function makeEfService(): jest.Mocked<Pick<EmploymentFactsService, "getFactsBatch" | "getSensitiveFactsBatch" | "getSensitiveFactsByPersonBatch">> {
  return {
    getFactsBatch: jest.fn().mockResolvedValue(new Map()),
    getSensitiveFactsBatch: jest.fn().mockResolvedValue(new Map()),
    getSensitiveFactsByPersonBatch: jest.fn().mockResolvedValue(new Map()),
  };
}

describe("loadRunEmployeePayees", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("the payee loader resolves identities in a single batched seam call for many payees, so the seam does not introduce an N+1 per payroll run", async () => {
    const employees = Array.from({ length: 30 }, (_, i) =>
      makeEmployee(i + 1, `user-${i + 1}`),
    );
    const db = makeDb(employees);
    const efService = makeEfService();

    const resolveIdentitiesMock = jest.mocked(personSeam.resolvePeopleIdentities);
    resolveIdentitiesMock.mockResolvedValue(new Map());

    await loadRunEmployeePayees(db, ORG, RUN_ID, efService as unknown as EmploymentFactsService);

    expect(resolveIdentitiesMock).toHaveBeenCalledTimes(1);
    const [, , subjects] = resolveIdentitiesMock.mock.calls[0];
    expect(subjects).toHaveLength(30);
    expect(subjects[0]).toEqual({ kind: "user", userId: "user-1" });
  });
});

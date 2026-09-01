import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import type { ListProfilesQuery } from "./dto/runs.schemas";
import { SalaryProfilesRepository } from "./salary-profiles.repository";

const dialect = new PgDialect();

function paramsOf(cond: unknown): unknown[] {
  return dialect.sqlToQuery(cond as SQL).params;
}

const DEFAULT_QUERY: ListProfilesQuery = { limit: 20 };

function makeListMock(dataRows: unknown[] = [], countTotal = 0) {
  let capturedWhere: unknown;

  const dataAfterWhere = {
    orderBy: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({
        offset: jest.fn().mockResolvedValue(dataRows),
      }),
    }),
  };

  function makeDataChain() {
    const chain: Record<string, unknown> = {};
    chain["from"] = jest.fn().mockReturnValue(chain);
    chain["leftJoin"] = jest.fn().mockReturnValue(chain);
    chain["where"] = jest.fn((cond: unknown) => {
      capturedWhere = cond;
      return dataAfterWhere;
    });
    return chain;
  }

  function makeCountChain() {
    const chain: Record<string, unknown> = {};
    chain["from"] = jest.fn().mockReturnValue(chain);
    chain["leftJoin"] = jest.fn().mockReturnValue(chain);
    chain["where"] = jest.fn().mockResolvedValue([{ total: countTotal }]);
    return chain;
  }

  let callNum = 0;
  const db = {
    select: jest.fn(() => {
      callNum += 1;
      return callNum === 1 ? makeDataChain() : makeCountChain();
    }),
  } as unknown as Db;

  return { db, getCapturedWhere: () => capturedWhere };
}

describe("SalaryProfilesRepository.list – tenant isolation", () => {
  it("includes the requesting orgId in the WHERE predicate", async () => {
    const { db, getCapturedWhere } = makeListMock();
    const repo = new SalaryProfilesRepository(db);
    await repo.list("org-alpha", DEFAULT_QUERY, "all", "user-1");
    expect(paramsOf(getCapturedWhere())).toContain("org-alpha");
  });

  it("does not include a foreign orgId in the WHERE predicate", async () => {
    const { db, getCapturedWhere } = makeListMock();
    const repo = new SalaryProfilesRepository(db);
    await repo.list("org-alpha", DEFAULT_QUERY, "all", "user-1");
    expect(paramsOf(getCapturedWhere())).not.toContain("org-other");
  });
});

describe("SalaryProfilesRepository.list – own scope", () => {
  it("includes the actor userId in WHERE when scope is own", async () => {
    const { db, getCapturedWhere } = makeListMock();
    const repo = new SalaryProfilesRepository(db);
    await repo.list("org-1", DEFAULT_QUERY, "own", "actor-user");
    expect(paramsOf(getCapturedWhere())).toContain("actor-user");
  });

  it("does not include a different userId in WHERE when scope is own", async () => {
    const { db, getCapturedWhere } = makeListMock();
    const repo = new SalaryProfilesRepository(db);
    await repo.list("org-1", DEFAULT_QUERY, "own", "actor-user");
    expect(paramsOf(getCapturedWhere())).not.toContain("other-user");
  });
});

describe("SalaryProfilesRepository.list – projection", () => {
  it("returns exactly the expected field set per row", async () => {
    const fakeRow = {
      id: 42,
      userId: "u-1",
      workerId: "w-1",
      workerType: "EMPLOYEE",
      currency: "INR",
      payoutCurrency: "INR",
      annualCtc: "1200000",
      taxRegime: "NEW",
      costCenter: "CC-1",
      status: "ACTIVE",
      effectiveFrom: "2024-01-01",
      userName: "Alice",
      userEmail: "alice@example.com",
      workerDisplayName: null,
      workerFirstName: null,
      workerLastName: null,
      workerEmail: null,
    };
    const { db } = makeListMock([fakeRow], 1);
    const repo = new SalaryProfilesRepository(db);
    const result = await repo.list("org-1", DEFAULT_QUERY, "all", "user-1");
    expect(result.data).toHaveLength(1);
    const EXPECTED_KEYS = [
      "annualCtc",
      "costCenter",
      "currency",
      "effectiveFrom",
      "id",
      "status",
      "taxRegime",
      "userEmail",
      "userId",
      "userName",
      "workerId",
      "workerType",
    ];
    expect(Object.keys(result.data[0]).sort()).toEqual(EXPECTED_KEYS);
  });

  it("payoutCurrency is not leaked through the list projection", async () => {
    const fakeRow = {
      id: 1,
      userId: "u-1",
      workerId: "w-1",
      workerType: "EMPLOYEE",
      currency: "INR",
      payoutCurrency: "USD",
      annualCtc: "500000",
      taxRegime: "OLD",
      costCenter: null,
      status: "ACTIVE",
      effectiveFrom: "2024-06-01",
      userName: null,
      userEmail: null,
      workerDisplayName: null,
      workerFirstName: null,
      workerLastName: null,
      workerEmail: null,
    };
    const { db } = makeListMock([fakeRow], 1);
    const repo = new SalaryProfilesRepository(db);
    const result = await repo.list("org-1", DEFAULT_QUERY, "all", "user-1");
    const row = result.data[0];
    expect(Object.keys(row)).not.toContain("payoutCurrency");
    expect(Object.keys(row)).not.toContain("workerDisplayName");
  });
});

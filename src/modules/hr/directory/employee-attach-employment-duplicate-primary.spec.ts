import { getTableConfig } from "drizzle-orm/pg-core";
import { hrEmployments } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { PersonEmploymentSyncService } from "../core/person-employment-sync.service";

const ORG_A = "org-alpha";
const ORG_B = "org-beta";
const USER_ID = "user-shared-1";
const SHARED_NUMBER = "EMP-0042";

const INPUT = {
  userId: USER_ID,
  firstName: "Jane",
  lastName: "Doe",
  workEmail: "jane.doe@example.com",
  employeeNumber: SHARED_NUMBER,
  joiningDate: "2026-01-05",
  designation: "Engineer",
  phone: null,
  lifecycleStatus: "ONBOARDING" as const,
};

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as Record<string, unknown>;
  return [
    ...(Array.isArray(record["queryChunks"]) ? sqlValues(record["queryChunks"], seen) : []),
    ...("value" in record ? sqlValues(record["value"], seen) : []),
  ];
}

interface Harness {
  db: Db;
  employmentFindFirst: jest.Mock;
  peopleFindFirst: jest.Mock;
  inserted: unknown[];
}

function makeHarness(employmentRows: readonly unknown[]): Harness {
  const queue = [...employmentRows];
  const employmentFindFirst = jest.fn(() => Promise.resolve(queue.shift() ?? undefined));
  const peopleFindFirst = jest.fn().mockResolvedValue({ id: 5, userId: USER_ID });
  const inserted: unknown[] = [];

  const db = {
    query: {
      hrPeople: { findFirst: peopleFindFirst },
      hrEmployments: { findFirst: employmentFindFirst },
      organizationPeople: { findFirst: jest.fn().mockResolvedValue(null) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      users: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn((values: unknown) => {
        inserted.push(values);
        return { returning: jest.fn().mockResolvedValue([{ id: 99 }]) };
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
        returning: jest.fn().mockResolvedValue([]),
      }),
    }),
  } as unknown as Db;

  return { db, employmentFindFirst, peopleFindFirst, inserted };
}

function buildService(db: Db): PersonEmploymentSyncService {
  return new PersonEmploymentSyncService(db, {
    log: jest.fn().mockResolvedValue(undefined),
    logMany: jest.fn().mockResolvedValue(undefined),
  } as never);
}

function indexedColumnName(column: unknown): string | null {
  if (typeof column !== "object" || column === null || !("name" in column)) return null;
  const { name } = column;
  return typeof name === "string" ? name : null;
}

describe("employment attachment cannot duplicate a primary — P4 acceptance", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("the database constraint the service has to respect", () => {
    it("scopes the employee number uniquely per organization, not globally", () => {
      const config = getTableConfig(hrEmployments);
      const byNumber = config.indexes.find(
        (index) => index.config.name === "uniq_hr_employments_org_emp_num",
      );

      expect(byNumber).toBeDefined();
      expect(byNumber?.config.unique).toBe(true);
      expect(byNumber?.config.columns.map(indexedColumnName)).toEqual([
        "org_id",
        "employee_number",
      ]);
    });

    it("declares no global unique on employee_number alone", () => {
      const config = getTableConfig(hrEmployments);
      const columnSets = [
        ...config.indexes.map((index) => index.config.columns),
        ...config.uniqueConstraints.map((constraint) => constraint.columns),
      ];
      const globalOnNumber = columnSets.some(
        (columns) =>
          columns?.length === 1 &&
          indexedColumnName(columns[0]) === "employee_number",
      );

      expect(columnSets.length).toBeGreaterThan(0);
      expect(globalOnNumber).toBe(false);
    });
  });

  describe("a person who already holds a live primary employment", () => {
    it("keeps that employment instead of inserting a second primary", async () => {
      const harness = makeHarness([{ id: 10, personId: 5, isPrimary: true }]);
      const service = buildService(harness.db);

      const result = await service.ensureFromUser(ORG_A, "actor-1", INPUT);

      expect(result).toEqual({
        personId: 5,
        employmentId: 10,
        createdPerson: false,
        createdEmployment: false,
      });
      expect(harness.inserted).toHaveLength(0);
    });

    it("looks the primary up by organization, person and is_primary on live rows only", async () => {
      const harness = makeHarness([{ id: 10, personId: 5, isPrimary: true }]);
      const service = buildService(harness.db);

      await service.ensureFromUser(ORG_A, "actor-1", INPUT);

      const bound = sqlValues(
        (harness.employmentFindFirst.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.[
          "where"
        ],
      );
      expect(bound).toContain(ORG_A);
      expect(bound).toContain(true);
      expect(bound).not.toContain(ORG_B);
    });
  });

  describe("the same employee number in a second organization", () => {
    it("is legal: the number lookup is bound to the acting organization", async () => {
      const harness = makeHarness([undefined, undefined]);
      const service = buildService(harness.db);

      const result = await service.ensureFromUser(ORG_B, "actor-2", INPUT);

      expect(result.createdEmployment).toBe(true);
      const numberLookup = sqlValues(
        (harness.employmentFindFirst.mock.calls[1]?.[0] as Record<string, unknown> | undefined)?.[
          "where"
        ],
      );
      expect(numberLookup).toContain(ORG_B);
      expect(numberLookup).toContain(SHARED_NUMBER);
      expect(numberLookup).not.toContain(ORG_A);
    });

    it("writes the requested number unchanged into the second organization", async () => {
      const harness = makeHarness([undefined, undefined]);
      const service = buildService(harness.db);

      await service.ensureFromUser(ORG_B, "actor-2", INPUT);

      expect(harness.inserted).toContainEqual(
        expect.objectContaining({
          orgId: ORG_B,
          personId: 5,
          employeeNumber: SHARED_NUMBER,
          isPrimary: true,
        }),
      );
    });
  });

  describe("the same number already taken inside this organization by another person", () => {
    it("suffixes rather than colliding, and still creates exactly one primary", async () => {
      const harness = makeHarness([undefined, { id: 11, personId: 6 }]);
      const service = buildService(harness.db);

      const result = await service.ensureFromUser(ORG_A, "actor-1", INPUT);

      expect(result.createdEmployment).toBe(true);
      const employmentInserts = harness.inserted.filter(
        (values): values is Record<string, unknown> =>
          typeof values === "object" && values !== null && "employeeNumber" in values,
      );
      expect(employmentInserts).toHaveLength(1);
      expect(String(employmentInserts[0]?.["employeeNumber"])).toMatch(
        new RegExp(`^${SHARED_NUMBER}-`),
      );
      expect(employmentInserts[0]?.["isPrimary"]).toBe(true);
    });

    it("reuses the row when that number already belongs to this same person", async () => {
      const harness = makeHarness([undefined, { id: 12, personId: 5 }]);
      const service = buildService(harness.db);

      const result = await service.ensureFromUser(ORG_A, "actor-1", INPUT);

      expect(result).toEqual({
        personId: 5,
        employmentId: 12,
        createdPerson: false,
        createdEmployment: false,
      });
      expect(harness.inserted).toHaveLength(0);
    });
  });
});

import { PersonEmploymentSyncService } from "../person-employment-sync.service";
import type { Db } from "../../../db/drizzle.module";
import type { HrAuditService } from "../hr-audit.service";

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
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const ATTACKER_ORG = "org-attacker-hr-sync";
const VICTIM_ORG = "org-victim-hr-sync";

const auditDep = { log: jest.fn() } as unknown as HrAuditService;

describe("PersonEmploymentSyncService — cross-tenant isolation", () => {
  it("ensureFromUserId returns null for a user that has no membership in the requesting org (different org isolation)", async () => {
    const findFirstMock = jest.fn().mockResolvedValue(null);
    const db = {
      query: {
        organizationMembers: { findFirst: findFirstMock },
        hrPeople: { findFirst: jest.fn().mockResolvedValue(null) },
        hrEmployments: { findFirst: jest.fn().mockResolvedValue(null) },
        users: { findFirst: jest.fn().mockResolvedValue(null) },
        organizationPeople: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }),
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ organizationPersonId: "op-99", id: 99 }]) }) }),
    } as unknown as Db;

    const svc = new PersonEmploymentSyncService(db, auditDep);
    const result = await svc.ensureFromUserId(ATTACKER_ORG, null, "user-belongs-to-victim-org");

    expect(result).toBeNull();

    const whereOpts = findFirstMock.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    const vals = sqlValues(whereOpts?.where);
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(VICTIM_ORG);
  });

  it("ensureFromUser queries hrPeople scoped to the requesting org — cross-tenant isolation: attacker org sees no victim data", async () => {
    const hrPeopleFindFirst = jest.fn().mockResolvedValue(null);
    const orgPeopleFindFirst = jest.fn().mockResolvedValue(null);

    const selectWhere = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) });
    const db = {
      query: {
        hrPeople: { findFirst: hrPeopleFindFirst },
        organizationPeople: { findFirst: orgPeopleFindFirst },
        hrEmployments: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({ where: selectWhere }),
          where: selectWhere,
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ organizationPersonId: "op-1", id: 50 }]),
        }),
      }),
    } as unknown as Db;

    const svc = new PersonEmploymentSyncService(db, auditDep);

    await svc.ensureFromUser(
      ATTACKER_ORG,
      null,
      {
        userId: "user-from-victim-org",
        firstName: "Alice",
        lastName: "Smith",
        workEmail: "alice@victim.com",
        employeeNumber: "EMP-001",
      },
    );

    const whereOpts = hrPeopleFindFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    const vals = sqlValues(whereOpts?.where);
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(VICTIM_ORG);
  });

  it("ensureFromUserId scopes membership check to requesting org — org predicate is always in the WHERE (tenant isolation)", async () => {
    const orgMemberFindFirst = jest.fn().mockResolvedValue(null);
    const db = {
      query: {
        organizationMembers: { findFirst: orgMemberFindFirst },
      },
    } as unknown as Db;

    const svc = new PersonEmploymentSyncService(db, auditDep);
    await svc.ensureFromUserId(ATTACKER_ORG, null, "user-999");

    expect(orgMemberFindFirst).toHaveBeenCalledTimes(1);
    const call = orgMemberFindFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    const vals = sqlValues(call?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });
});

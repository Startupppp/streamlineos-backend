import { ProjectsWorkQueryService } from "./projects-work-query.service";
import type { AccessService } from "../../../access/access.service";
import { MEMBER_STANDING, principalAccess } from "../project-crud/__tests__/project-access-doubles";

const memberAccess = () => principalAccess(MEMBER_STANDING) as unknown as AccessService;
import type { Db } from "../../../../db/drizzle.module";
import type { AllWorkQuery } from "../dto/projects.schemas";

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

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

const BASE_QUERY = {
  limit: 25,
  orderBy: "created",
  scope: "all",
} as AllWorkQuery;

function makeUser(orgId: string) {
  return {
    orgId,
    userId: "u1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: { kind: "human-session" as const, membershipId: 1, isOrgOwner: false },
  };
}

describe("ProjectsWorkQueryService — cross-tenant isolation", () => {
  it("returns empty when attacker org has no project membership (DENY — cross-tenant isolation)", async () => {
    const capturedWhere = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    });
    const rowChain = {
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          leftJoin: jest.fn().mockReturnValue({
            leftJoin: jest.fn().mockReturnValue({ where: capturedWhere }),
          }),
        }),
      }),
    };
    const countChain = {
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ total: "0" }]),
        }),
      }),
    };
    const db = {
      select: jest.fn()
        .mockReturnValueOnce(rowChain)
        .mockReturnValueOnce(countChain),
    } as unknown as Db;

    const svc = new ProjectsWorkQueryService(db, memberAccess());
    const result = await svc.getAllWork(makeUser(ATTACKER_ORG), BASE_QUERY);

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
    const whereVals = sqlValues(capturedWhere.mock.calls[0]?.[0]);
    expect(whereVals).toContain(ATTACKER_ORG);
    expect(whereVals).not.toContain(OWNER_ORG);
  });

  it("returns tickets for a member of the owning org (CONTROL — same-tenant access works)", async () => {
    const ticketRow = {
      id: 1,
      title: "Fix login",
      status: "TODO",
      priority: "MEDIUM",
      type: "BUG",
      dueDate: null,
      startDate: null,
      ticketNumber: 1,
      points: null,
      estimate: null,
      rank: null,
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
      assigneeId: null,
      assigneeName: null,
      assigneeFirstName: null,
      assigneeLastName: null,
      assigneeEmail: null,
      assigneeImage: null,
      sprintId: null,
      cycleId: null,
      epicId: null,
      projectId: 10,
      projectKey: "PROJ",
      projectName: "Main Project",
    };

    const ticketLimit = jest.fn().mockResolvedValue([ticketRow]);
    const ticketOrderBy = jest.fn().mockReturnValue({ limit: ticketLimit });
    const ticketWhere = jest.fn().mockReturnValue({ orderBy: ticketOrderBy });
    const ticketLeftJoin2 = jest.fn().mockReturnValue({ where: ticketWhere });
    const ticketLeftJoin1 = jest.fn().mockReturnValue({ leftJoin: ticketLeftJoin2 });
    const ticketInnerJoin = jest.fn().mockReturnValue({ leftJoin: ticketLeftJoin1 });
    const ticketFrom = jest.fn().mockReturnValue({ innerJoin: ticketInnerJoin });

    const countWhere = jest.fn().mockResolvedValue([{ total: "1" }]);
    const countInnerJoin = jest.fn().mockReturnValue({ where: countWhere });
    const countFrom = jest.fn().mockReturnValue({ innerJoin: countInnerJoin });

    const labelWhere = jest.fn().mockResolvedValue([]);
    const labelInnerJoin = jest.fn().mockReturnValue({ where: labelWhere });
    const labelFrom = jest.fn().mockReturnValue({ innerJoin: labelInnerJoin });

    const select = jest.fn()
      .mockReturnValueOnce({ from: ticketFrom })
      .mockReturnValueOnce({ from: countFrom })
      .mockReturnValueOnce({ from: labelFrom });

    const db = { select } as unknown as Db;
    const svc = new ProjectsWorkQueryService(db, memberAccess());
    const result = await svc.getAllWork(makeUser(OWNER_ORG), BASE_QUERY);

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ title: "Fix login", projectId: 10 });
    expect(result.total).toBe(1);
  });
});

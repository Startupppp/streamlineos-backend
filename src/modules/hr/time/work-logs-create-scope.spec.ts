import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import type { Db } from "../../../db/drizzle.module";
import { addDays, formatDateOnly, subDays } from "../../../common/date";
import { WORKLOGS_PERMISSION } from "./worklogs-scope";
import { WORK_LOG_BACKDATE_DAYS, WorkLogsService } from "./work-logs.service";

const ORG = "org-1";
const ACTOR = "actor-1";
const EMPLOYEE = "employee-9";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

interface DbHarness {
  db: Db;
  memberWheres: unknown[];
  insertedValues: Array<Record<string, unknown>>;
}

function makeDb(memberRows: Array<Array<{ id: number }>>, existing: unknown = null): DbHarness {
  const memberWheres: unknown[] = [];
  const insertedValues: Array<Record<string, unknown>> = [];
  const queue = [...memberRows];

  const builder = {
    from: () => builder,
    where: (w: unknown) => {
      memberWheres.push(w);
      return builder;
    },
    limit: () => builder,
    then: <T,>(resolve: (rows: Array<{ id: number }>) => T) =>
      Promise.resolve(queue.shift() ?? []).then(resolve),
  };

  const insertChain = {
    values: (v: Record<string, unknown>) => {
      insertedValues.push(v);
      return insertChain;
    },
    onConflictDoUpdate: () => insertChain,
    returning: () => Promise.resolve([{ id: 1, ...insertedValues[insertedValues.length - 1] }]),
  };

  const db = {
    select: () => builder,
    insert: () => insertChain,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    query: {
      timesheets: { findFirst: () => Promise.resolve(existing) },
    },
  } as unknown as Db;

  return { db, memberWheres, insertedValues };
}

function makeAccess(scope: DataScope): AccessService {
  return {
    resolveUserPermissions: jest
      .fn()
      .mockResolvedValue(new Map<string, DataScope>([[WORKLOGS_PERMISSION, scope]])),
  } as unknown as AccessService;
}

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: ACTOR,
    orgId: ORG,
    role: "EMPLOYEE",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...overrides,
  };
}

const audit = { logCritical: jest.fn() } as never;
const dispatch = {} as never;

const today = formatDateOnly(new Date());

describe("WorkLogsService.create — who may be written for", () => {
  beforeEach(() => jest.clearAllMocks());

  it("refuses a target userId from a caller whose attendance scope is only own", async () => {
    const { db } = makeDb([[{ id: 5 }]]);
    const svc = new WorkLogsService(db, audit, makeAccess("own"), dispatch);
    await expect(
      svc.create(makeUser(), { date: today, userId: EMPLOYEE, description: "x" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("lets an all-scope HR admin write against the employee's membership, not their own", async () => {
    const { db, memberWheres, insertedValues } = makeDb([[{ id: 77 }]]);
    const svc = new WorkLogsService(db, audit, makeAccess("all"), dispatch);
    const row = await svc.create(makeUser(), {
      date: today,
      userId: EMPLOYEE,
      description: "onsite visit",
    });
    expect(sqlValues(memberWheres[0])).toContain(EMPLOYEE);
    expect(insertedValues[0]?.userMembershipId).toBe(77);
    expect(row).toBeTruthy();
  });

  it("404s a target userId that is not a member of the caller's org (never a cross-tenant write)", async () => {
    const { db, insertedValues } = makeDb([[]]);
    const svc = new WorkLogsService(db, audit, makeAccess("all"), dispatch);
    await expect(
      svc.create(makeUser(), { date: today, userId: EMPLOYEE, description: "x" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(insertedValues).toHaveLength(0);
  });

  it("still writes the caller's own log when no userId is supplied", async () => {
    const { db, memberWheres, insertedValues } = makeDb([[{ id: 5 }]]);
    const svc = new WorkLogsService(db, audit, makeAccess("own"), dispatch);
    await svc.create(makeUser(), { date: today, description: "mine" });
    expect(sqlValues(memberWheres[0])).toContain(ACTOR);
    expect(insertedValues[0]?.userMembershipId).toBe(5);
  });
});

describe("WorkLogsService.create — which dates are writable", () => {
  beforeEach(() => jest.clearAllMocks());

  it("accepts a member backdating inside the window, so yesterday is enterable", async () => {
    const { db, insertedValues } = makeDb([[{ id: 5 }]]);
    const svc = new WorkLogsService(db, audit, makeAccess("own"), dispatch);
    const yesterday = formatDateOnly(subDays(new Date(), 1));
    await svc.create(makeUser(), { date: yesterday, description: "late entry" });
    expect(insertedValues[0]?.date).toBe(yesterday);
  });

  it("refuses a member backdating beyond the window", async () => {
    const { db } = makeDb([[{ id: 5 }]]);
    const svc = new WorkLogsService(db, audit, makeAccess("own"), dispatch);
    const tooOld = formatDateOnly(subDays(new Date(), WORK_LOG_BACKDATE_DAYS + 1));
    await expect(
      svc.create(makeUser(), { date: tooOld, description: "x" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("lets an all-scope caller correct a date older than the member window", async () => {
    const { db, insertedValues } = makeDb([[{ id: 5 }]]);
    const svc = new WorkLogsService(db, audit, makeAccess("all"), dispatch);
    const tooOld = formatDateOnly(subDays(new Date(), WORK_LOG_BACKDATE_DAYS + 30));
    await svc.create(makeUser(), { date: tooOld, description: "correction" });
    expect(insertedValues[0]?.date).toBe(tooOld);
  });

  it("refuses a future date even for an all-scope caller", async () => {
    const { db } = makeDb([[{ id: 5 }]]);
    const svc = new WorkLogsService(db, audit, makeAccess("all"), dispatch);
    const tomorrow = formatDateOnly(addDays(new Date(), 1));
    await expect(
      svc.create(makeUser(), { date: tomorrow, description: "x" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

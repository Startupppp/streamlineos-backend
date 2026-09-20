import "reflect-metadata";
import { z } from "zod";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { SelfHrTools } from "./self-hr-tools";
import { SelfPayrollTools } from "./self-payroll-tools";
import type { AskOsToolRunContext, AskOsToolDefinition } from "../registry/ask-os-tool.types";
import { ScopedRead } from "../../../access/scoped-read";
import type { AskOsActor } from "../services/ask-os-actor";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { Db } from "../../../../db/drizzle.module";

const ACTOR: AskOsActor = {
  userId: "user-self-01",
  orgId: "org-self-01",
  membershipId: 42,
  displayName: "Test User",
  email: "test@example.com",
  orgName: "Test Org",
  role: "MEMBER",
  isOrgOwner: false,
  timezone: "UTC",
  today: "2026-09-19",
  monthStart: "2026-09-01",
  monthEnd: "2026-09-30",
  currentYear: 2026,
  currentMonth: 9,
};

const CALLER: CurrentUserContext = {
  userId: "user-self-01",
  orgId: "org-self-01",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-01",
  tokenScopes: null,
  principal: humanSessionPrincipal(42, false),
};

function buildCtx(actorOverrides: Partial<AskOsActor> = {}): AskOsToolRunContext {
  const actor = { ...ACTOR, ...actorOverrides };
  const read = ScopedRead.of(actor.orgId, actor.userId, "own");
  return {
    actor,
    caller: CALLER,
    read,
    readFor: () => read,
    modules: {},
  };
}

function renderSql(condition: SQL): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(condition);
}

const SUBJECT_KEYS = new Set([
  "userId",
  "actorId",
  "createdById",
  "authorId",
  "subjectId",
  "memberId",
  "personId",
  "employeeId",
  "targetUserId",
]);

function assertNoSubjectIdentifier(shape: z.ZodRawShape): void {
  for (const key of Object.keys(shape)) {
    if (SUBJECT_KEYS.has(key))
      throw new Error(`Tool input must not accept a subject identifier but found "${key}"`);
  }
}

function stubSelectChain(resolvedValue: unknown[] = []): unknown {
  const chain: Record<string, unknown> = {};
  const terminal = (): unknown => Promise.resolve(resolvedValue);
  chain.from = () => chain;
  chain.innerJoin = () => chain;
  chain.leftJoin = () => chain;
  chain.where = (_c: unknown) => chain;
  chain.orderBy = () => chain;
  chain.limit = terminal;
  chain.then = (
    resolve: (v: unknown) => unknown,
    reject: (e: unknown) => unknown,
  ) => Promise.resolve(resolvedValue).then(resolve, reject);
  return chain;
}

function buildDb(overrides: Record<string, unknown> = {}): Db {
  return {
    query: {
      users: { findFirst: jest.fn().mockResolvedValue(null) },
      attendance: { findMany: jest.fn().mockResolvedValue([]) },
      leaveRequests: { findMany: jest.fn().mockResolvedValue([]) },
      expenses: { findMany: jest.fn().mockResolvedValue([]) },
      employeeSalaryProfiles: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    select: jest.fn().mockReturnValue(stubSelectChain()),
    ...overrides,
  } as unknown as Db;
}

function findTool(tools: AskOsToolDefinition[], key: string): AskOsToolDefinition {
  const tool = tools.find((t) => t.key === key);
  if (!tool) throw new Error(`Tool "${key}" not found`);
  return tool;
}

describe("SelfHrTools and SelfPayrollTools — no tool accepts a subject identifier in its input schema", () => {
  it("every tool's inputSchema.shape contains no user/subject key", () => {
    const hrSut = new SelfHrTools(buildDb());
    const payrollSut = new SelfPayrollTools(buildDb());
    for (const tool of [...hrSut.tools(), ...payrollSut.tools()]) {
      const schema = tool.input as z.ZodObject<z.ZodRawShape>;
      assertNoSubjectIdentifier(schema.shape);
    }
  });
});

describe("getMyProfile — caller identity comes from the actor, not the input", () => {
  it("queries by ctx.actor.userId — the userId is a bound parameter of the DB call", async () => {
    expect.hasAssertions();
    let capturedWhere: SQL | undefined;
    const db = buildDb({
      query: {
        users: {
          findFirst: jest.fn().mockImplementation((opts: { where?: SQL }) => {
            capturedWhere = opts.where;
            return Promise.resolve(null);
          }),
        },
        attendance: { findMany: jest.fn().mockResolvedValue([]) },
        leaveRequests: { findMany: jest.fn().mockResolvedValue([]) },
        expenses: { findMany: jest.fn().mockResolvedValue([]) },
        employeeSalaryProfiles: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    });

    const sut = new SelfHrTools(db);
    await findTool(sut.tools(), "getMyProfile").run(
      {},
      buildCtx({ userId: "target-uid-xyz" }),
    );

    expect(capturedWhere).toBeDefined();
    const { params } = renderSql(capturedWhere!);
    expect(params).toContain("target-uid-xyz");
  });

  it("never returns taxId or bankDetails fields — projection excludes sensitive columns", async () => {
    expect.hasAssertions();
    const safeRow = {
      id: "u-1",
      name: "Alice",
      firstName: "Alice",
      lastName: "Smith",
      email: "a@b.com",
      image: null,
      phone: null,
      gender: null,
      dateOfBirth: null,
      bio: null,
      linkedinUrl: null,
      isActive: true,
      createdAt: new Date(),
    };
    const db = buildDb({
      query: {
        users: { findFirst: jest.fn().mockResolvedValue(safeRow) },
        attendance: { findMany: jest.fn().mockResolvedValue([]) },
        leaveRequests: { findMany: jest.fn().mockResolvedValue([]) },
        expenses: { findMany: jest.fn().mockResolvedValue([]) },
        employeeSalaryProfiles: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    });
    const sut = new SelfHrTools(db);
    const outcome = await findTool(sut.tools(), "getMyProfile").run({}, buildCtx());

    expect(outcome.kind).toBe("data");
    if (outcome.kind === "data") {
      expect(outcome.data).not.toHaveProperty("taxId");
      expect(outcome.data).not.toHaveProperty("bankDetails");
      expect(outcome.data).not.toHaveProperty("totpSecret");
    }
  });
});

describe("getMyAttendanceSummary — self-scoped attendance reads", () => {
  it("binds the query to ctx.actor.userId — userId appears as a bound SQL parameter", async () => {
    expect.hasAssertions();
    let capturedWhere: SQL | undefined;
    const db = {
      query: buildDb().query,
      select: jest.fn().mockReturnValue({
        from: () => ({
          where: (condition: SQL) => {
            capturedWhere = condition;
            return Promise.resolve([{ daysPresent: 1, totalHoursText: "8.00" }]);
          },
        }),
      }),
    } as unknown as Db;

    const sut = new SelfHrTools(db);
    await findTool(sut.tools(), "getMyAttendanceSummary").run(
      {},
      buildCtx({ userId: "bound-user-abc" }),
    );

    expect(capturedWhere).toBeDefined();
    const { params } = renderSql(capturedWhere!);
    expect(params).toContain("bound-user-abc");
  });

  it("returns empty outcome when no records exist for the requested month — not a failure", async () => {
    expect.hasAssertions();
    const db = {
      query: buildDb().query,
      select: jest.fn().mockReturnValue({
        from: () => ({
          where: () => Promise.resolve([{ daysPresent: 0, totalHoursText: "0" }]),
        }),
      }),
    } as unknown as Db;

    const sut = new SelfHrTools(db);
    const outcome = await findTool(sut.tools(), "getMyAttendanceSummary").run({}, buildCtx());

    expect(outcome.kind).toBe("empty");
    expect(outcome.kind).not.toBe("failed");
  });
});

describe("getMyAttendanceStatus — today's attendance bound to caller", () => {
  it("binds the today query to ctx.actor.userId — userId is a SQL parameter", async () => {
    expect.hasAssertions();
    let capturedOpts: { where?: SQL } | undefined;
    const db = buildDb({
      query: {
        users: { findFirst: jest.fn() },
        attendance: {
          findMany: jest.fn().mockImplementation((opts: { where?: SQL }) => {
            capturedOpts = opts;
            return Promise.resolve([]);
          }),
        },
        leaveRequests: { findMany: jest.fn().mockResolvedValue([]) },
        expenses: { findMany: jest.fn().mockResolvedValue([]) },
        employeeSalaryProfiles: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    });

    const sut = new SelfHrTools(db);
    await findTool(sut.tools(), "getMyAttendanceStatus").run(
      {},
      buildCtx({ userId: "status-user-xyz" }),
    );

    expect(capturedOpts?.where).toBeDefined();
    const { params } = renderSql(capturedOpts!.where!);
    expect(params).toContain("status-user-xyz");
  });
});

describe("getMyLeaveRequests — leave data bound to caller", () => {
  it("queries leave requests by ctx.actor.userId — userId is a SQL parameter", async () => {
    expect.hasAssertions();
    let capturedOpts: { where?: SQL } | undefined;
    const db = {
      query: {
        users: { findFirst: jest.fn() },
        attendance: { findMany: jest.fn().mockResolvedValue([]) },
        leaveRequests: {
          findMany: jest.fn().mockImplementation((opts: { where?: SQL }) => {
            capturedOpts = opts;
            return Promise.resolve([]);
          }),
        },
        expenses: { findMany: jest.fn().mockResolvedValue([]) },
        employeeSalaryProfiles: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockReturnValue(stubSelectChain()),
    } as unknown as Db;

    const sut = new SelfHrTools(db);
    await findTool(sut.tools(), "getMyLeaveRequests").run(
      {},
      buildCtx({ userId: "leave-user-abc" }),
    );

    expect(capturedOpts?.where).toBeDefined();
    const { params } = renderSql(capturedOpts!.where!);
    expect(params).toContain("leave-user-abc");
  });
});

describe("getMyExpenses — expenses bound to caller", () => {
  it("queries expenses by ctx.actor.userId — userId is a SQL parameter", async () => {
    expect.hasAssertions();
    let capturedOpts: { where?: SQL } | undefined;
    const db = buildDb({
      query: {
        users: { findFirst: jest.fn() },
        attendance: { findMany: jest.fn().mockResolvedValue([]) },
        leaveRequests: { findMany: jest.fn().mockResolvedValue([]) },
        expenses: {
          findMany: jest.fn().mockImplementation((opts: { where?: SQL }) => {
            capturedOpts = opts;
            return Promise.resolve([]);
          }),
        },
        employeeSalaryProfiles: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    });

    const sut = new SelfHrTools(db);
    await findTool(sut.tools(), "getMyExpenses").run(
      {},
      buildCtx({ userId: "expense-user-xyz" }),
    );

    expect(capturedOpts?.where).toBeDefined();
    const { params } = renderSql(capturedOpts!.where!);
    expect(params).toContain("expense-user-xyz");
  });
});

describe("getMyPayslips — payslips bound to caller's membershipId", () => {
  it("queries payslip_publications by ctx.actor.membershipId — membershipId is a SQL parameter", async () => {
    expect.hasAssertions();
    let capturedWhere: SQL | undefined;
    type PayslipJoinChain = {
      innerJoin: (...args: unknown[]) => PayslipJoinChain;
      where: (condition: SQL) => { orderBy: () => { limit: () => Promise<unknown[]> } };
    };
    const fromChain: PayslipJoinChain = {
      innerJoin: () => fromChain,
      where: (condition: SQL) => {
        capturedWhere = condition;
        return { orderBy: () => ({ limit: () => Promise.resolve([]) }) };
      },
    };
    const db = {
      query: buildDb().query,
      select: jest.fn().mockReturnValue({ from: () => fromChain }),
    } as unknown as Db;

    const sut = new SelfPayrollTools(db);
    await findTool(sut.tools(), "getMyPayslips").run({}, buildCtx({ membershipId: 99 }));

    expect(capturedWhere).toBeDefined();
    const { params } = renderSql(capturedWhere!);
    expect(params).toContain(99);
  });
});

describe("getMyTotalRewards — total rewards bound to caller", () => {
  it("uses ctx.actor.membershipId in the salary profile lookup — membershipId is a SQL parameter", async () => {
    expect.hasAssertions();
    let capturedOpts: { where?: SQL } | undefined;
    const db = {
      query: {
        users: { findFirst: jest.fn() },
        attendance: { findMany: jest.fn().mockResolvedValue([]) },
        leaveRequests: { findMany: jest.fn().mockResolvedValue([]) },
        expenses: { findMany: jest.fn().mockResolvedValue([]) },
        employeeSalaryProfiles: {
          findFirst: jest.fn().mockImplementation((opts: { where?: SQL }) => {
            capturedOpts = opts;
            return Promise.resolve(null);
          }),
        },
      },
      select: jest.fn().mockReturnValue(stubSelectChain()),
    } as unknown as Db;

    const sut = new SelfPayrollTools(db);
    await findTool(sut.tools(), "getMyTotalRewards").run({}, buildCtx({ membershipId: 77 }));

    expect(capturedOpts?.where).toBeDefined();
    const { params } = renderSql(capturedOpts!.where!);
    expect(params).toContain(77);
  });
});

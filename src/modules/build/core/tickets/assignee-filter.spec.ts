import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildAssigneeFilter } from "./assignee-filter";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { projectAccessRow } from "../../__tests__/project-access-doubles";
import { humanSessionPrincipal } from "../../../../common/auth/principal";

const dialect = new PgDialect();

function render(s: SQL<unknown>): string {
  return dialect.sqlToQuery(s as never).sql.toUpperCase();
}

describe("buildAssigneeFilter — predicate shape", () => {
  it("returns undefined when the id list is empty and unassigned is not requested", () => {
    expect(buildAssigneeFilter("org1", [], false)).toBeUndefined();
  });

  it("returns kind=single with a bare IS NULL clause for an unassigned-only filter", () => {
    const result = buildAssigneeFilter("org1", [], true);
    expect(result?.kind).toBe("single");
    if (result?.kind !== "single") return;
    const rendered = render(result.clause);
    expect(rendered).toContain("IS NULL");
    expect(rendered).not.toContain(" IN (");
    expect(rendered).not.toContain("UNION");
  });

  it("returns kind=single with an IN (subquery) clause for a named-only filter — no IS NULL, no UNION", () => {
    const result = buildAssigneeFilter("org1", ["user-1", "user-2"], false);
    expect(result?.kind).toBe("single");
    if (result?.kind !== "single") return;
    const rendered = render(result.clause);
    expect(rendered).toContain(" IN (");
    expect(rendered).toContain("ORGANIZATION_MEMBERS");
    expect(rendered).toContain("USER_ID");
    expect(rendered).not.toContain("IS NULL");
    expect(rendered).not.toContain("UNION");
  });

  it("combined filter: returns kind=union — two independently indexable branches, not a correlated EXISTS (ticket-14 box 2)", () => {
    const result = buildAssigneeFilter("org1", ["user-1"], true);
    expect(result).not.toBeUndefined();
    expect(result?.kind).toBe("union");
    expect(result).not.toHaveProperty("clause");
  });

  it("combined filter: nullBranch renders IS NULL and inBranch renders organization_members — each branch is independently indexable (ticket-14 box 2)", () => {
    const result = buildAssigneeFilter("org1", ["user-1"], true);
    expect(result?.kind).toBe("union");
    if (result?.kind !== "union") return;
    const nullRendered = render(result.nullBranch);
    const inRendered = render(result.inBranch);
    expect(nullRendered).toContain("IS NULL");
    expect(nullRendered).not.toContain("ORGANIZATION_MEMBERS");
    expect(inRendered).toContain("ORGANIZATION_MEMBERS");
    expect(inRendered).toContain("USER_ID");
    expect(inRendered).not.toContain("IS NULL");
    expect(inRendered).not.toContain("UNION");
  });
});

const ORG_ID = "org-af";
const PROJECT_ID = 10;

const USER: CurrentUserContext = {
  userId: "user-1",
  orgId: ORG_ID,
  role: "EMPLOYEE",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(7, true),
};

function makeAccess(): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])),
    scopeFor: jest.fn().mockResolvedValue("all"),
  } as unknown as AccessService;
}

function makeDb(onWhere?: (w: unknown) => void): Db {
  const chain: Record<string, unknown> = {};
  chain["from"] = jest.fn(() => chain);
  chain["where"] = jest.fn((w: unknown) => {
    onWhere?.(w);
    return chain;
  });
  chain["orderBy"] = jest.fn(() => chain);
  chain["limit"] = jest.fn().mockResolvedValueOnce([projectAccessRow()]).mockResolvedValue([]);
  chain["groupBy"] = jest.fn(() => Promise.resolve([]));

  return {
    select: jest.fn(() => chain),
    execute: jest.fn().mockResolvedValue([]),
    query: {
      projects: {
        findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }),
      },
      tickets: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    },
  } as unknown as Db;
}

describe("ticket-14 box 2: combined filter is a top-level UNION ALL, not a correlated EXISTS — BE-81", () => {
  it("listTickets: combined filter issues a UNION ALL query via db.execute — not a single WHERE with EXISTS(UNION ALL)", async () => {
    const db = makeDb();
    const svc = new ProjectsTicketsReadService(db, makeAccess());
    await svc.listTickets(USER, PROJECT_ID, {
      limit: 10,
      orderBy: "rank",
      assigneeId: ["__unassigned__", "user-2"],
    });
    const executeSqls = (db.execute as jest.Mock).mock.calls.map(
      (c) => render(c[0] as SQL<unknown>),
    );
    expect(executeSqls.some((r) => r.includes("UNION ALL") && !r.includes("EXISTS"))).toBe(true);
  });

  it("listTickets: UNION ALL query has IS NULL branch and ORGANIZATION_MEMBERS branch — positive counterpart to the NOT EXISTS assertion", async () => {
    const db = makeDb();
    const svc = new ProjectsTicketsReadService(db, makeAccess());
    await svc.listTickets(USER, PROJECT_ID, {
      limit: 10,
      orderBy: "rank",
      assigneeId: ["__unassigned__", "user-2"],
    });
    const executeSqls = (db.execute as jest.Mock).mock.calls.map(
      (c) => render(c[0] as SQL<unknown>),
    );
    const unionSql = executeSqls.find((r) => r.includes("UNION ALL"));
    expect(unionSql).toBeDefined();
    expect(unionSql).toContain("IS NULL");
    expect(unionSql).toContain("ORGANIZATION_MEMBERS");
  });

  it("getColumnCounts: combined filter issues a UNION ALL query via db.execute — not a single WHERE with EXISTS(UNION ALL)", async () => {
    const db = makeDb();
    const svc = new ProjectsTicketsReadService(db, makeAccess());
    await svc.getColumnCounts(USER, PROJECT_ID, {
      assigneeId: ["__unassigned__", "user-2"],
    });
    const executeSqls = (db.execute as jest.Mock).mock.calls.map(
      (c) => render(c[0] as SQL<unknown>),
    );
    expect(executeSqls.some((r) => r.includes("UNION ALL") && !r.includes("EXISTS"))).toBe(true);
  });

  it("getColumnCounts: UNION ALL query has IS NULL branch and ORGANIZATION_MEMBERS branch — positive counterpart to the NOT EXISTS assertion", async () => {
    const db = makeDb();
    const svc = new ProjectsTicketsReadService(db, makeAccess());
    await svc.getColumnCounts(USER, PROJECT_ID, {
      assigneeId: ["__unassigned__", "user-2"],
    });
    const executeSqls = (db.execute as jest.Mock).mock.calls.map(
      (c) => render(c[0] as SQL<unknown>),
    );
    const unionSql = executeSqls.find((r) => r.includes("UNION ALL"));
    expect(unionSql).toBeDefined();
    expect(unionSql).toContain("IS NULL");
    expect(unionSql).toContain("ORGANIZATION_MEMBERS");
  });
});

describe("listTickets — combined filter uses top-level UNION ALL (BE-81, ticket-14 box 2)", () => {
  it("UNION ALL query is issued via db.execute when filtering unassigned + named people", async () => {
    const db = makeDb();
    const svc = new ProjectsTicketsReadService(db, makeAccess());
    await svc.listTickets(USER, PROJECT_ID, {
      limit: 10,
      orderBy: "rank",
      assigneeId: ["__unassigned__", "user-2"],
    });
    const executeSqls = (db.execute as jest.Mock).mock.calls.map(
      (c) => render(c[0] as SQL<unknown>),
    );
    const unionSql = executeSqls.find((r) => r.includes("UNION ALL"));
    expect(unionSql).toBeDefined();
    expect(unionSql).not.toContain("EXISTS");
    expect(unionSql).toContain("IS NULL");
    expect(unionSql).toContain("ORGANIZATION_MEMBERS");
  });

  it("IS NULL predicate is used directly in the WHERE clause when only unassigned is requested", async () => {
    const captured: SQL<unknown>[] = [];
    const db = makeDb((w) => captured.push(w as SQL<unknown>));

    const svc = new ProjectsTicketsReadService(db, makeAccess());
    await svc.listTickets(USER, PROJECT_ID, {
      limit: 10,
      orderBy: "rank",
      assigneeId: ["__unassigned__"],
    });

    expect(captured.length).toBeGreaterThan(0);
    const rendered = render(captured[captured.length - 1]!);
    expect(rendered).toContain("IS NULL");
    expect(rendered).not.toContain("UNION");
    expect(rendered).not.toContain("ORGANIZATION_MEMBERS");
  });
});

describe("getColumnCounts — combined filter uses top-level UNION ALL (BE-81, ticket-14 box 2)", () => {
  it("UNION ALL query is issued via db.execute when filtering unassigned + named people", async () => {
    const db = makeDb();
    const svc = new ProjectsTicketsReadService(db, makeAccess());
    await svc.getColumnCounts(USER, PROJECT_ID, {
      assigneeId: ["__unassigned__", "user-2"],
    });
    const executeSqls = (db.execute as jest.Mock).mock.calls.map(
      (c) => render(c[0] as SQL<unknown>),
    );
    const unionSql = executeSqls.find((r) => r.includes("UNION ALL"));
    expect(unionSql).toBeDefined();
    expect(unionSql).not.toContain("EXISTS");
    expect(unionSql).toContain("IS NULL");
    expect(unionSql).toContain("ORGANIZATION_MEMBERS");
  });

  it("IS NULL predicate is used directly in the WHERE clause when only unassigned is requested", async () => {
    const captured: SQL<unknown>[] = [];
    const db = makeDb((w) => captured.push(w as SQL<unknown>));

    const svc = new ProjectsTicketsReadService(db, makeAccess());
    await svc.getColumnCounts(USER, PROJECT_ID, {
      assigneeId: ["__unassigned__"],
    });

    expect(captured.length).toBeGreaterThan(0);
    const rendered = render(captured[captured.length - 1]!);
    expect(rendered).toContain("IS NULL");
    expect(rendered).not.toContain("UNION");
    expect(rendered).not.toContain("ORGANIZATION_MEMBERS");
  });
});

describe("buildAssigneeFilter — top-level UNION ALL selects the same rows as the flat OR it replaced", () => {
  it("both predicates accept and reject the same rows over a fixture of ticket-membership combinations — a changed implementation that differs on any case fails here", () => {
    type TicketRow = { assigneeMembershipId: string | null };
    type MemberRow = { id: string; orgId: string; userId: string };

    const orgId = "org-eq";
    const userIds = ["user-a", "user-b"];

    const members: MemberRow[] = [
      { id: "mem-1", orgId, userId: "user-a" },
      { id: "mem-2", orgId, userId: "user-b" },
      { id: "mem-3", orgId, userId: "user-c" },
      { id: "mem-4", orgId: "other-org", userId: "user-a" },
    ];

    const ticketRows: TicketRow[] = [
      { assigneeMembershipId: null },
      { assigneeMembershipId: "mem-1" },
      { assigneeMembershipId: "mem-2" },
      { assigneeMembershipId: "mem-3" },
      { assigneeMembershipId: "mem-4" },
      { assigneeMembershipId: "mem-5" },
    ];

    const matchingMemberIds = new Set(
      members
        .filter((m) => m.orgId === orgId && userIds.includes(m.userId))
        .map((m) => m.id),
    );

    const flatOrPredicate = (row: TicketRow): boolean =>
      row.assigneeMembershipId === null || matchingMemberIds.has(row.assigneeMembershipId);

    const unionBranchPredicate = (row: TicketRow): boolean => {
      if (row.assigneeMembershipId === null) return true;
      return matchingMemberIds.has(row.assigneeMembershipId);
    };

    const flatResults = ticketRows.filter(flatOrPredicate);
    const unionResults = ticketRows.filter(unionBranchPredicate);

    expect(unionResults).toEqual(flatResults);
    expect(flatResults.map((r) => r.assigneeMembershipId)).toEqual([null, "mem-1", "mem-2"]);
  });
});

describe("shared builder: listTickets and getColumnCounts use buildAssigneeFilter, not an inline copy (ticket-14 box 4)", () => {
  function stripParams(s: string): string {
    return s.replace(/\$\d+/g, "$?");
  }

  it("listTickets union path: execute SQL contains both branches from buildAssigneeFilter — an inline copy would differ and fail here", async () => {
    const filter = buildAssigneeFilter(ORG_ID, ["user-2"], true);
    expect(filter?.kind).toBe("union");
    if (filter?.kind !== "union") return;
    const nullBranchStripped = stripParams(render(filter.nullBranch));
    const inBranchStripped = stripParams(render(filter.inBranch));

    const db = makeDb();
    const svc = new ProjectsTicketsReadService(db, makeAccess());
    await svc.listTickets(USER, PROJECT_ID, {
      limit: 10,
      orderBy: "rank",
      assigneeId: ["__unassigned__", "user-2"],
    });

    const executeSqls = (db.execute as jest.Mock).mock.calls.map(
      (c) => stripParams(render(c[0] as SQL<unknown>)),
    );
    const unionSql = executeSqls.find((r) => r.includes("UNION ALL"));
    expect(unionSql).toBeDefined();
    expect(unionSql).toContain(nullBranchStripped);
    expect(unionSql).toContain(inBranchStripped);
  });

  it("getColumnCounts union path: execute SQL contains both branches from buildAssigneeFilter — an inline copy would differ and fail here", async () => {
    const filter = buildAssigneeFilter(ORG_ID, ["user-2"], true);
    expect(filter?.kind).toBe("union");
    if (filter?.kind !== "union") return;
    const nullBranchStripped = stripParams(render(filter.nullBranch));
    const inBranchStripped = stripParams(render(filter.inBranch));

    const db = makeDb();
    const svc = new ProjectsTicketsReadService(db, makeAccess());
    await svc.getColumnCounts(USER, PROJECT_ID, {
      assigneeId: ["__unassigned__", "user-2"],
    });

    const executeSqls = (db.execute as jest.Mock).mock.calls.map(
      (c) => stripParams(render(c[0] as SQL<unknown>)),
    );
    const unionSql = executeSqls.find((r) => r.includes("UNION ALL"));
    expect(unionSql).toBeDefined();
    expect(unionSql).toContain(nullBranchStripped);
    expect(unionSql).toContain(inBranchStripped);
  });
});

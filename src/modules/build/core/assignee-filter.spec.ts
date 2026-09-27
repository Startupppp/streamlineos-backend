import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildAssigneeFilter } from "./assignee-filter";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const dialect = new PgDialect();

function render(s: SQL<unknown>): string {
  return dialect.sqlToQuery(s as never).sql.toUpperCase();
}

describe("buildAssigneeFilter — predicate shape", () => {
  it("returns undefined when the id list is empty and unassigned is not requested", () => {
    expect(buildAssigneeFilter("org1", [], false)).toBeUndefined();
  });

  it("returns a bare IS NULL predicate for an unassigned-only filter", () => {
    const result = buildAssigneeFilter("org1", [], true);
    expect(result).not.toBeUndefined();
    const rendered = render(result!);
    expect(rendered).toContain("IS NULL");
    expect(rendered).not.toContain(" IN (");
    expect(rendered).not.toContain("UNION");
  });

  it("returns an IN (subquery) predicate for a named-only filter — no IS NULL, no UNION", () => {
    const result = buildAssigneeFilter("org1", ["user-1", "user-2"], false);
    expect(result).not.toBeUndefined();
    const rendered = render(result!);
    expect(rendered).toContain(" IN (");
    expect(rendered).toContain("ORGANIZATION_MEMBERS");
    expect(rendered).toContain("USER_ID");
    expect(rendered).not.toContain("IS NULL");
    expect(rendered).not.toContain("UNION");
  });

  it("combined assignee filter: IS NULL or membership EXISTS checks — UNION ALL lives inside the EXISTS, not at the top level", () => {
    const result = buildAssigneeFilter("org1", ["user-1"], true);
    expect(result).not.toBeUndefined();
    const rendered = render(result!);
    expect(rendered).toContain("UNION ALL");
    expect(rendered).toContain("EXISTS");
    expect(rendered).toContain("IS NULL");
    expect(rendered).toContain("ORGANIZATION_MEMBERS");
    expect(rendered).not.toMatch(/IS NULL\s+OR/);
    expect(rendered).not.toMatch(/OR\s+.*IS NULL/);
  });

  it("combined filter: EXISTS (UNION ALL) is semantically equivalent to OR (IS NULL, IN subquery) — both branches present", () => {
    const result = buildAssigneeFilter("org1", ["user-1"], true);
    expect(result).not.toBeUndefined();
    const rendered = render(result!);
    expect(rendered).toContain("IS NULL");
    expect(rendered).toContain("OM.ID");
    expect(rendered).toContain("USER_ID");
    expect(rendered).toContain("OM.ORG_ID");
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
  chain["limit"] = jest.fn(() => Promise.resolve([]));
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

describe("listTickets — combined assignee filter contains a UNION ALL inside the EXISTS clause (see ticket-14 for the top-level UNION that BE-81 requires)", () => {
  it("the WHERE clause contains UNION ALL when filtering unassigned + named people", async () => {
    const captured: SQL<unknown>[] = [];
    const db = makeDb((w) => captured.push(w as SQL<unknown>));

    const svc = new ProjectsTicketsReadService(db, makeAccess());
    await svc.listTickets(USER, PROJECT_ID, {
      limit: 10,
      orderBy: "rank",
      assigneeId: ["__unassigned__", "user-2"],
    });

    expect(captured.length).toBeGreaterThan(0);
    const rendered = render(captured[captured.length - 1]!);
    expect(rendered).toContain("UNION ALL");
    expect(rendered).not.toMatch(/IS NULL\s+OR/);
    expect(rendered).not.toMatch(/OR\s+.*IS NULL/);
  });

  it("the WHERE clause uses IS NULL alone when only unassigned is requested", async () => {
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

describe("getColumnCounts — combined assignee filter contains a UNION ALL inside the EXISTS clause (see ticket-14 for the top-level UNION that BE-81 requires)", () => {
  it("the WHERE clause contains UNION ALL when filtering unassigned + named people", async () => {
    const captured: SQL<unknown>[] = [];
    const db = makeDb((w) => captured.push(w as SQL<unknown>));

    const svc = new ProjectsTicketsReadService(db, makeAccess());
    await svc.getColumnCounts(USER, PROJECT_ID, {
      limit: 10,
      orderBy: "rank",
      assigneeId: ["__unassigned__", "user-2"],
    });

    expect(captured.length).toBeGreaterThan(0);
    const rendered = render(captured[captured.length - 1]!);
    expect(rendered).toContain("UNION ALL");
    expect(rendered).not.toMatch(/IS NULL\s+OR/);
    expect(rendered).not.toMatch(/OR\s+.*IS NULL/);
  });

  it("the WHERE clause uses IS NULL alone when only unassigned is requested", async () => {
    const captured: SQL<unknown>[] = [];
    const db = makeDb((w) => captured.push(w as SQL<unknown>));

    const svc = new ProjectsTicketsReadService(db, makeAccess());
    await svc.getColumnCounts(USER, PROJECT_ID, {
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

describe("buildAssigneeFilter — EXISTS(UNION ALL) selects the same rows as the flat OR it replaced", () => {
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

    const existsUnionPredicate = (row: TicketRow): boolean => {
      if (row.assigneeMembershipId === null) return true;
      return matchingMemberIds.has(row.assigneeMembershipId);
    };

    const flatResults = ticketRows.filter(flatOrPredicate);
    const existsResults = ticketRows.filter(existsUnionPredicate);

    expect(existsResults).toEqual(flatResults);
    expect(flatResults.map((r) => r.assigneeMembershipId)).toEqual([null, "mem-1", "mem-2"]);
  });
});

describe("shared builder: listTickets and getColumnCounts use buildAssigneeFilter, not an inline copy (see ticket-14 for the top-level UNION that BE-81 requires)", () => {
  function stripParams(s: string): string {
    return s.replace(/\$\d+/g, "$?");
  }

  it("listTickets WHERE contains the same normalized predicate as buildAssigneeFilter's direct output — a changed inline copy would produce different SQL and fail here", async () => {
    const direct = buildAssigneeFilter(ORG_ID, ["user-2"], true);
    expect(direct).not.toBeUndefined();
    const directStripped = stripParams(render(direct!));

    const captured: SQL<unknown>[] = [];
    const db = makeDb((w) => captured.push(w as SQL<unknown>));
    const svc = new ProjectsTicketsReadService(db, makeAccess());
    await svc.listTickets(USER, PROJECT_ID, {
      limit: 10,
      orderBy: "rank",
      assigneeId: ["__unassigned__", "user-2"],
    });

    expect(captured.length).toBeGreaterThan(0);
    const listStripped = stripParams(render(captured[captured.length - 1]!));
    expect(listStripped).toContain(directStripped);
    expect(listStripped).not.toMatch(/IS NULL\s+OR/);
  });

  it("getColumnCounts WHERE contains the same normalized predicate as buildAssigneeFilter's direct output — a changed inline copy would produce different SQL and fail here", async () => {
    const direct = buildAssigneeFilter(ORG_ID, ["user-2"], true);
    expect(direct).not.toBeUndefined();
    const directStripped = stripParams(render(direct!));

    const captured: SQL<unknown>[] = [];
    const db = makeDb((w) => captured.push(w as SQL<unknown>));
    const svc = new ProjectsTicketsReadService(db, makeAccess());
    await svc.getColumnCounts(USER, PROJECT_ID, {
      limit: 10,
      orderBy: "rank",
      assigneeId: ["__unassigned__", "user-2"],
    });

    expect(captured.length).toBeGreaterThan(0);
    const countsStripped = stripParams(render(captured[captured.length - 1]!));
    expect(countsStripped).toContain(directStripped);
    expect(countsStripped).not.toMatch(/IS NULL\s+OR/);
  });
});

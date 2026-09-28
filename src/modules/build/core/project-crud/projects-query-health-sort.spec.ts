import { PgDialect } from "drizzle-orm/pg-core";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { ProjectsQueryService, computeHealth } from "./projects-query.service";
import { AuditService } from "../../../../common/audit/audit.service";
import { AccessService } from "../../../access/access.service";
import type { Db } from "../../../../db/drizzle.module";
import { encodeCursor } from "../../../../common/pagination/cursor";

const dialect = new PgDialect();

function render(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

interface Captured {
  where: unknown;
  orderBy: unknown[];
  selections: Record<string, unknown>[];
  limit: number;
}

function buildDb(captured: Captured, projectRows: unknown[] = []) {
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    leftJoin: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    innerJoinLateral: jest.fn().mockReturnThis(),
    as: jest.fn().mockReturnThis(),
    where: jest.fn((cond: unknown) => {
      captured.where = cond;
      return builder;
    }),
    orderBy: jest.fn((...cols: unknown[]) => {
      captured.orderBy = cols;
      return builder;
    }),
    limit: jest.fn((n: number) => {
      captured.limit = n;
      return Promise.resolve(projectRows);
    }),
    groupBy: jest.fn().mockReturnThis(),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  return {
    select: jest.fn((selection: Record<string, unknown>) => {
      captured.selections.push(selection);
      return builder;
    }),
  } as unknown as Db;
}

const mockAccess = {
  scopeFor: jest.fn().mockResolvedValue("all"),
} as unknown as AccessService;

async function captureQuery(input: {
  sort?: string;
  afterSortValue?: string;
  afterId?: number;
  health?: string;
  projectRows?: unknown[];
}): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [], selections: [], limit: 0 };
  const svc = new ProjectsQueryService(
    buildDb(captured, input.projectRows ?? []),
    {} as AuditService,
    mockAccess,
  );
  await svc.listProjects(
    { orgId: "org-1", userId: "u-1", principal: humanSessionPrincipal(1, false) } as never,
    {
      afterId: input.afterId,
      afterSortValue: input.afterSortValue,
      limit: 9,
      status: "ALL",
      search: undefined,
      sort: input.sort as never,
      health: input.health as never,
    },
  );
  return captured;
}

describe("computeHealth — same expression used by projection and filter", () => {
  const now = new Date("2025-01-15T00:00:00.000Z");

  it("returns on_track for completed projects regardless of progress", () => {
    expect(computeHealth("COMPLETED", null, 0, now)).toBe("on_track");
  });

  it("returns on_track for archived projects regardless of progress", () => {
    expect(computeHealth("ARCHIVED", "2020-01-01", 0, now)).toBe("on_track");
  });

  it("returns off_track for overdue active projects with low progress", () => {
    expect(computeHealth("ACTIVE", "2025-01-01", 10, now)).toBe("off_track");
  });

  it("returns on_track when pct >= 70 and not overdue", () => {
    expect(computeHealth("ACTIVE", "2026-12-31", 70, now)).toBe("on_track");
  });

  it("returns at_risk when pct >= 30 and < 70 and not overdue", () => {
    expect(computeHealth("ACTIVE", "2026-12-31", 50, now)).toBe("at_risk");
  });

  it("returns off_track when pct < 30 and not overdue", () => {
    expect(computeHealth("ACTIVE", "2026-12-31", 20, now)).toBe("off_track");
  });

  it("returns on_track for active project with no endDate and pct >= 70", () => {
    expect(computeHealth("ACTIVE", null, 75, now)).toBe("on_track");
  });
});

describe("health filter — filter uses the same expression as the projection", () => {
  it("fetches PAGE_SIZE_CAP rows when health filter is provided", async () => {
    const { limit } = await captureQuery({ health: "on_track" });
    expect(limit).toBe(100);
  });

  it("fetches limit+1 rows when no health filter", async () => {
    const { limit } = await captureQuery({});
    expect(limit).toBe(10);
  });
});

describe("sort ORDER BY — keyset matches the sort column", () => {
  it("name_asc orders by name asc then id asc", async () => {
    const { orderBy } = await captureQuery({ sort: "name_asc" });
    const rendered = orderBy.map(render);
    expect(rendered[0]).toContain('"name"');
    expect(rendered[0]).toContain("asc");
    expect(rendered[1]).toContain('"id"');
    expect(rendered[1]).toContain("asc");
  });

  it("priority_desc orders by priority desc then id desc", async () => {
    const { orderBy } = await captureQuery({ sort: "priority_desc" });
    const rendered = orderBy.map(render);
    expect(rendered[0]).toContain('"priority"');
    expect(rendered[0]).toContain("desc");
    expect(rendered[1]).toContain('"id"');
  });

  it("due_asc orders by end_date asc then id asc", async () => {
    const { orderBy } = await captureQuery({ sort: "due_asc" });
    const rendered = orderBy.map(render);
    expect(rendered[0]).toContain('"end_date"');
    expect(rendered[0]).toContain("asc");
    expect(rendered[1]).toContain('"id"');
  });

  it("default sort orders by id desc only", async () => {
    const { orderBy } = await captureQuery({});
    const rendered = orderBy.map(render);
    expect(rendered.length).toBe(1);
    expect(rendered[0]).toContain('"id"');
    expect(rendered[0]).toContain("desc");
  });
});

describe("sort cursor — composite predicate prevents skipped or repeated rows", () => {
  it("name_asc with cursor adds (name, id) > (value, id) predicate", async () => {
    const cursor = encodeCursor({ sortValue: "Alpha", id: "5" });
    const { where } = await captureQuery({ sort: "name_asc", afterSortValue: cursor });
    const sql = render(where);
    expect(sql).toContain(">");
  });

  it("priority_desc with cursor adds (priority, id) < (value, id) predicate", async () => {
    const cursor = encodeCursor({ sortValue: "HIGH", id: "10" });
    const { where } = await captureQuery({ sort: "priority_desc", afterSortValue: cursor });
    const sql = render(where);
    expect(sql).toContain("<");
  });

  it("name_asc with no cursor omits the cursor predicate", async () => {
    const { where } = await captureQuery({ sort: "name_asc" });
    const sql = render(where);
    expect(sql).not.toContain("Alpha");
  });

  it("two rows sharing the same name are distinguished by id tiebreak in cursor", () => {
    const pos1 = encodeCursor({ sortValue: "ProjectX", id: "3" });
    const pos2 = encodeCursor({ sortValue: "ProjectX", id: "7" });
    expect(pos1).not.toBe(pos2);
  });
});

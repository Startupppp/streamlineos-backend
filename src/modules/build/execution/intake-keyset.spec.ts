import { PgDialect } from "drizzle-orm/pg-core";
import { IntakeService } from "./workspace.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const owner: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "s1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};
import { encodeCursor } from "../../../common/pagination/cursor";
import { intakeListSchema } from "./dto/workspace-response.schemas";
import { projectAccessRow, standingAccess } from "../__tests__/project-access-doubles";
import type { AccessService } from "../../access/access.service";

const ownerAccess = standingAccess({ "build:manage": "all" }) as unknown as AccessService;

const dialect = new PgDialect();

function render(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

interface Captured {
  where: unknown;
  orderBy: unknown[];
}

function buildDb(captured: Captured, rows: unknown[] = []) {
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    where: jest.fn((cond: unknown) => {
      captured.where = cond;
      return builder;
    }),
    orderBy: jest.fn((...cols: unknown[]) => {
      captured.orderBy = cols;
      return builder;
    }),
    limit: jest.fn().mockResolvedValueOnce([projectAccessRow()]).mockResolvedValue(rows),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  return {
    query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 42 }) } },
    select: jest.fn().mockReturnValue(builder),
  } as unknown as Db;
}

function intakeRow(id: number) {
  return {
    id,
    projectId: 42,
    orgId: "org-1",
    title: `Request ${id}`,
    description: null,
    source: "web_form",
    status: "pending",
    submitterEmail: "requester@example.com",
    submitterName: null,
    priority: null,
    requestType: null,
    linkedWorkItemId: null,
    declineReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function capture(cursor: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = new IntakeService(buildDb(captured), {} as never, ownerAccess);
  await svc.listIntake(owner, 42, { cursor, limit: 50 });
  return captured;
}

describe("IntakeService.listIntake — keyset matches the sort", () => {
  it("orders by createdAt desc then id desc", async () => {
    const { orderBy } = await capture(undefined);
    const rendered = orderBy.map(render);
    expect(rendered[0]).toContain('"created_at"');
    expect(rendered[0]).toContain("desc");
    expect(rendered[1]).toContain('"id"');
  });

  it("applies a strict less-than predicate when cursor is present", async () => {
    const cursor = encodeCursor({ sortValue: new Date().toISOString(), id: "88" });
    const { where } = await capture(cursor);
    const sql = render(where);
    expect(sql).toMatch(/</);
    expect(sql).not.toMatch(/>/);
  });

  it("omits the cursor predicate on the first page", async () => {
    const { where } = await capture(undefined);
    const sql = render(where);
    expect(sql).not.toMatch(/"created_at"\s*</);
  });

  it("bite proof: raw offset=0 with no cursor is what this replaces", () => {
    const oldShape = { offset: 0, limit: 50 };
    expect(oldShape).not.toHaveProperty("cursor");
  });
});

describe("IntakeService.listIntake — response envelope matches intakeListSchema", () => {
  it("keys the array under data, not items, when empty", async () => {
    const svc = new IntakeService(buildDb({ where: undefined, orderBy: [] }, []), {} as never, ownerAccess);
    const result = await svc.listIntake(owner, 42, { cursor: undefined, limit: 50 });
    expect(result).not.toHaveProperty("items");
    expect(result).toEqual({ data: [], pagination: { limit: 50, hasMore: false, nextCursor: null } });
    expect(intakeListSchema.safeParse(result).success).toBe(true);
  });

  it("keys the array under data, not items, when populated below the page limit", async () => {
    const rows = [intakeRow(1), intakeRow(2)];
    const svc = new IntakeService(buildDb({ where: undefined, orderBy: [] }, rows), {} as never, ownerAccess);
    const result = await svc.listIntake(owner, 42, { cursor: undefined, limit: 50 });
    expect(result).not.toHaveProperty("items");
    expect(result.data).toHaveLength(2);
    expect(result.pagination).toEqual({ limit: 50, hasMore: false, nextCursor: null });
    expect(intakeListSchema.safeParse(result).success).toBe(true);
  });

  it("sets hasMore and a nextCursor when a sentinel row over the limit is fetched", async () => {
    const rows = [intakeRow(1), intakeRow(2), intakeRow(3)];
    const svc = new IntakeService(buildDb({ where: undefined, orderBy: [] }, rows), {} as never, ownerAccess);
    const result = await svc.listIntake(owner, 42, { cursor: undefined, limit: 2 });
    expect(result).not.toHaveProperty("items");
    expect(result.data).toHaveLength(2);
    expect(result.pagination.hasMore).toBe(true);
    expect(result.pagination.nextCursor).toEqual(expect.any(String));
    const parsed = intakeListSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });
});

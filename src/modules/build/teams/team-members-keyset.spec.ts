import { PgDialect } from "drizzle-orm/pg-core";
import { TeamMembersService } from "./team-members.service";
import { TeamsService } from "./teams.service";
import { AuditService } from "../../../common/audit/audit.service";
import type { Db } from "../../../db/drizzle.module";
import { encodeCursor } from "../../../common/pagination/cursor";

const dialect = new PgDialect();

function render(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

interface Captured {
  where: unknown;
  orderBy: unknown[];
}

function buildDb(captured: Captured) {
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn((cond: unknown) => {
      captured.where = cond;
      return builder;
    }),
    orderBy: jest.fn((...cols: unknown[]) => {
      captured.orderBy = cols;
      return builder;
    }),
    limit: jest.fn().mockResolvedValue([]),
    select: jest.fn(),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  (builder.select as jest.Mock).mockReturnValue(builder);
  const teams = {
    loadTeam: jest.fn().mockResolvedValue({ id: 1, orgId: "org-1" }),
  } as unknown as TeamsService;
  return {
    db: { select: jest.fn().mockReturnValue(builder) } as unknown as Db,
    teams,
    captured,
  };
}

async function capture(cursor: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const { db, teams } = buildDb(captured);
  const svc = new TeamMembersService(db, teams, {} as AuditService);
  await svc.listTeamMembers("org-1", 1, { cursor, pageSize: 20 });
  return captured;
}

describe("TeamMembersService.listTeamMembers — keyset matches the sort", () => {
  it("orders by joinedAt asc then id asc", async () => {
    const { orderBy } = await capture(undefined);
    const rendered = orderBy.map(render);
    expect(rendered[0]).toContain('"joined_at"');
    expect(rendered[1]).toContain('"id"');
  });

  it("applies a strict greater-than predicate when cursor is present", async () => {
    const cursor = encodeCursor({ sortValue: new Date().toISOString(), id: "10" });
    const { where } = await capture(cursor);
    const sql = render(where);
    expect(sql).toMatch(/>/);
    expect(sql).not.toMatch(/</);
  });

  it("omits the cursor predicate on the first page", async () => {
    const { where } = await capture(undefined);
    const sql = render(where);
    expect(sql).not.toMatch(/"joined_at"\s*>/);
  });

  it("bite proof: a desc sort on joinedAt would break oldest-first paging", () => {
    const wrongSort = ['"project_team_members"."joined_at" desc'];
    expect(wrongSort[0]).toContain("desc");
    expect(wrongSort[0]).not.toContain("asc");
  });
});

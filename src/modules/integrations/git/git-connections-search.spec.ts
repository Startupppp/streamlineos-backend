import { PgDialect } from "drizzle-orm/pg-core";
import { GitConnectionsService } from "./git-connections.service";
import type { Db } from "../../../db/drizzle.module";

const dialect = new PgDialect();

function render(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

interface Captured {
  where: unknown;
}

function buildDb(captured: Captured) {
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn((cond: unknown) => {
      captured.where = cond;
      return builder;
    }),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  (builder.leftJoin as jest.Mock).mockReturnValue(builder);
  return { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
}

async function captureWhere(search: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined };
  const svc = new GitConnectionsService(buildDb(captured));
  await svc.listConnections("org-1", { limit: 50, search });
  return captured;
}

describe("GitConnectionsService.listConnections — search reaches the WHERE clause", () => {
  it("includes an ILIKE predicate on repo_url when search is provided", async () => {
    const { where } = await captureWhere("acme");
    const sql = render(where);
    expect(sql).toContain("ilike");
    expect(sql).toContain("repo_url");
  });

  it("includes an ILIKE predicate on repo_name when search is provided", async () => {
    const { where } = await captureWhere("acme");
    const sql = render(where);
    expect(sql).toContain("repo_name");
  });

  it("omits the ILIKE predicate when search is undefined — no-op first page with no filter", async () => {
    const { where } = await captureWhere(undefined);
    const sql = render(where);
    expect(sql).not.toContain("ilike");
  });

  it("omits the ILIKE predicate when search is an empty string — whitespace-only is trimmed to empty", async () => {
    const { where } = await captureWhere("   ");
    const sql = render(where);
    expect(sql).not.toContain("ilike");
  });
});

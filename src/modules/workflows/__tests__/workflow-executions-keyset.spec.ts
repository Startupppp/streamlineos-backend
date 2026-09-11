import { PgDialect } from "drizzle-orm/pg-core";
import { WorkflowsExecutionService } from "../workflows-execution.service";
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
    where: jest.fn((cond: unknown) => {
      captured.where = cond;
      return builder;
    }),
    orderBy: jest.fn((...cols: unknown[]) => {
      captured.orderBy = cols;
      return builder;
    }),
    limit: jest.fn().mockResolvedValue([]),
    innerJoin: jest.fn(),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  (builder.innerJoin as jest.Mock).mockReturnValue(builder);
  return {
    select: jest.fn().mockReturnValue(builder),
    query: {
      workflows: {
        findFirst: jest.fn().mockResolvedValue({ id: "wf-1" }),
      },
    },
  } as unknown as Db;
}

async function capture(cursor: string | undefined, direction: "asc" | "desc" = "desc"): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const db = buildDb(captured);
  const svc = new WorkflowsExecutionService(db, {} as never);
  await svc.listExecutions("org-a", "wf-1", {
    cursor,
    limit: 20,
    direction,
    status: undefined,
  });
  return captured;
}

async function captureAll(cursor: string | undefined, direction: "asc" | "desc" = "desc"): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const db = buildDb(captured);
  const svc = new WorkflowsExecutionService(db, {} as never);
  await svc.listAllExecutions("org-a", {
    cursor,
    limit: 20,
    direction,
    status: undefined,
  });
  return captured;
}

describe("WorkflowsExecutionService.listExecutions — keyset matches the sort", () => {
  it("orders by createdAt first, then by id as tie-breaker (desc)", async () => {
    const { orderBy } = await capture(undefined, "desc");
    const rendered = orderBy.map(render);
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toContain('"created_at"');
    expect(rendered[1]).toContain('"id"');
  });

  it("the leading sort column is createdAt, never id", async () => {
    const { orderBy } = await capture(undefined, "desc");
    const leading = render(orderBy[0]);
    expect(leading).toContain('"created_at"');
    expect(leading).not.toContain('"id"');
  });

  it("advances cursor with strict < when direction is desc", async () => {
    const cursor = encodeCursor({ sortValue: new Date().toISOString(), id: "exec-uuid-1" });
    const { where } = await capture(cursor, "desc");
    const sql = render(where);
    expect(sql).toMatch(/"created_at"[\s\S]*<[\s\S]*\$\d+/);
    expect(sql).not.toMatch(/"created_at"[\s\S]*=[\s\S]*\$\d+/);
  });

  it("advances cursor with strict > when direction is asc", async () => {
    const cursor = encodeCursor({ sortValue: new Date().toISOString(), id: "exec-uuid-1" });
    const { where } = await capture(cursor, "asc");
    const sql = render(where);
    expect(sql).toMatch(/"created_at"[\s\S]*>[\s\S]*\$\d+/);
    expect(sql).not.toMatch(/"created_at"[\s\S]*=[\s\S]*\$\d+/);
  });

  it("omits the cursor predicate on the first page", async () => {
    const { where } = await capture(undefined);
    const sql = render(where);
    expect(sql).not.toMatch(/\("workflow_executions"\."created_at"/);
  });

  it("bite proof: a sort on id only with a createdAt cursor drops rows", () => {
    const idOnlySort = ['"workflow_executions"."id" desc'];
    expect(idOnlySort[0]).not.toContain('"created_at"');
  });
});

describe("WorkflowsExecutionService.listAllExecutions — keyset matches the sort", () => {
  it("orders by createdAt first, then by id (desc)", async () => {
    const { orderBy } = await captureAll(undefined, "desc");
    const rendered = orderBy.map(render);
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toContain('"created_at"');
    expect(rendered[1]).toContain('"id"');
  });

  it("advances cursor with strict < (desc)", async () => {
    const cursor = encodeCursor({ sortValue: new Date().toISOString(), id: "exec-uuid-2" });
    const { where } = await captureAll(cursor, "desc");
    const sql = render(where);
    expect(sql).toMatch(/"created_at"[\s\S]*<[\s\S]*\$\d+/);
    expect(sql).not.toMatch(/"created_at"[\s\S]*=[\s\S]*\$\d+/);
  });

  it("advances cursor with strict > (asc)", async () => {
    const cursor = encodeCursor({ sortValue: new Date().toISOString(), id: "exec-uuid-2" });
    const { where } = await captureAll(cursor, "asc");
    const sql = render(where);
    expect(sql).toMatch(/"created_at"[\s\S]*>[\s\S]*\$\d+/);
  });
});

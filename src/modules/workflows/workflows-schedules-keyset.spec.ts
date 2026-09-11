import { PgDialect } from "drizzle-orm/pg-core";
import { WorkflowsSchedulesService } from "./workflows-schedules.service";
import { WorkflowsSecretsService } from "./workflows-secrets.service";
import { encodeCursor } from "../../common/pagination/cursor";
import type { Db } from "../../db/drizzle.module";

const dialect = new PgDialect();

function render(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

interface Captured {
  where: unknown;
  orderBy: unknown[];
}

function buildListDb(captured: Captured): Db {
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
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  return { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
}

function buildListDbWithQuery(captured: Captured): Db {
  const findFirst = jest.fn().mockResolvedValue({ id: "wf-id" });
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
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  return {
    select: jest.fn().mockReturnValue(builder),
    query: { workflows: { findFirst } },
  } as unknown as Db;
}

async function captureAllSchedules(cursor: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = new WorkflowsSchedulesService(buildListDb(captured));
  await svc.listAllSchedules("org-a", { cursor, limit: 20 });
  return captured;
}

async function captureWorkflowSchedules(cursor: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = new WorkflowsSchedulesService(buildListDbWithQuery(captured));
  await svc.listSchedules("org-a", "wf-id", { cursor, limit: 20 });
  return captured;
}

async function captureGlobalSecrets(cursor: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = new WorkflowsSecretsService(buildListDb(captured));
  await svc.listGlobalSecrets("org-a", { cursor, limit: 20 });
  return captured;
}

async function captureWorkflowSecrets(cursor: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = new WorkflowsSecretsService(buildListDbWithQuery(captured));
  await svc.listSecrets("org-a", "wf-id", { cursor, limit: 20 });
  return captured;
}

describe("WorkflowsSchedulesService.listAllSchedules — keyset matches sort", () => {
  it("orders by created_at as the leading sort column", async () => {
    const { orderBy } = await captureAllSchedules(undefined);
    expect(orderBy).toHaveLength(2);
    expect(render(orderBy[0])).toContain('"created_at"');
  });

  it("id is the tiebreaker sort column", async () => {
    const { orderBy } = await captureAllSchedules(undefined);
    expect(render(orderBy[1])).toContain('"id"');
  });

  it("advances cursor with strict < inequality on created_at", async () => {
    const cursor = encodeCursor({ sortValue: new Date("2024-01-01T00:00:00.000Z").toISOString(), id: "some-uuid-tie" });
    const { where } = await captureAllSchedules(cursor);
    const sql = render(where);
    expect(sql).toMatch(/"created_at"[\s\S]*<[\s\S]*\$\d+/);
  });

  it("omits cursor predicate on the first page", async () => {
    const { where } = await captureAllSchedules(undefined);
    const sql = render(where);
    expect(sql).not.toMatch(/<\s*\$\d+/);
  });

  it("bite proof: leading sort column is not org_id", async () => {
    const { orderBy } = await captureAllSchedules(undefined);
    expect(render(orderBy[0])).not.toContain('"org_id"');
  });
});

describe("WorkflowsSchedulesService.listSchedules — keyset matches sort", () => {
  it("orders by created_at DESC as the leading sort column", async () => {
    const { orderBy } = await captureWorkflowSchedules(undefined);
    expect(orderBy).toHaveLength(2);
    expect(render(orderBy[0])).toContain('"created_at"');
  });

  it("id is the tiebreaker sort column", async () => {
    const { orderBy } = await captureWorkflowSchedules(undefined);
    expect(render(orderBy[1])).toContain('"id"');
  });

  it("advances cursor with strict < inequality on created_at", async () => {
    const cursor = encodeCursor({ sortValue: new Date("2024-06-15T12:00:00.000Z").toISOString(), id: "tie-uuid" });
    const { where } = await captureWorkflowSchedules(cursor);
    const sql = render(where);
    expect(sql).toMatch(/"created_at"[\s\S]*<[\s\S]*\$\d+/);
  });

  it("omits cursor predicate on the first page", async () => {
    const { where } = await captureWorkflowSchedules(undefined);
    expect(render(where)).not.toMatch(/<\s*\$\d+/);
  });
});

describe("WorkflowsSecretsService.listGlobalSecrets — keyset matches sort", () => {
  it("orders by created_at as the leading sort column", async () => {
    const { orderBy } = await captureGlobalSecrets(undefined);
    expect(orderBy).toHaveLength(2);
    expect(render(orderBy[0])).toContain('"created_at"');
  });

  it("id is the tiebreaker sort column", async () => {
    const { orderBy } = await captureGlobalSecrets(undefined);
    expect(render(orderBy[1])).toContain('"id"');
  });

  it("advances cursor with strict < inequality", async () => {
    const cursor = encodeCursor({ sortValue: new Date("2024-03-10T09:00:00.000Z").toISOString(), id: "secret-uuid" });
    const { where } = await captureGlobalSecrets(cursor);
    const sql = render(where);
    expect(sql).toMatch(/"created_at"[\s\S]*<[\s\S]*\$\d+/);
  });

  it("omits cursor predicate on the first page", async () => {
    const { where } = await captureGlobalSecrets(undefined);
    expect(render(where)).not.toMatch(/<\s*\$\d+/);
  });
});

describe("WorkflowsSecretsService.listSecrets — keyset matches sort", () => {
  it("orders by created_at as the leading sort column", async () => {
    const { orderBy } = await captureWorkflowSecrets(undefined);
    expect(orderBy).toHaveLength(2);
    expect(render(orderBy[0])).toContain('"created_at"');
  });

  it("id is the tiebreaker sort column", async () => {
    const { orderBy } = await captureWorkflowSecrets(undefined);
    expect(render(orderBy[1])).toContain('"id"');
  });

  it("advances cursor with strict < inequality", async () => {
    const cursor = encodeCursor({ sortValue: new Date("2024-05-01T00:00:00.000Z").toISOString(), id: "sec-uuid" });
    const { where } = await captureWorkflowSecrets(cursor);
    const sql = render(where);
    expect(sql).toMatch(/"created_at"[\s\S]*<[\s\S]*\$\d+/);
  });
});

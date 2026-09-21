jest.mock("../timesheets-core-scope", () => ({
  ...jest.requireActual("../timesheets-core-scope"),
  resolveEntriesScope: jest
    .fn()
    .mockResolvedValue(jest.requireActual("../../../access/scoped-read").ScopedRead.of("org-1", "user-1", "all")),
}));

import { PgDialect } from "drizzle-orm/pg-core";
import { TimesheetExceptionsService } from "../exceptions.service";
import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

const dialect = new PgDialect();

function render(v: unknown): string {
  return dialect.sqlToQuery(v as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

interface Captured {
  where: unknown;
  orderBy: unknown[];
}

function buildDb(captured: Captured) {
  const b: Record<string, unknown> = {
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn((c: unknown) => {
      captured.where = c;
      return b;
    }),
    orderBy: jest.fn((...cols: unknown[]) => {
      captured.orderBy = cols;
      return b;
    }),
    limit: jest.fn().mockResolvedValue([]),
  };
  return { select: jest.fn().mockReturnValue(b) } as unknown as Db;
}

const USER: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  isOrgOwner: false,
  principal: { kind: "human-session", membershipId: 1 },
} as unknown as CurrentUserContext;

const CURSOR = Buffer.from("2024-01-15T10:00:00.000Z\x001").toString("base64url");

async function capture(cursor: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = new TimesheetExceptionsService(buildDb(captured), {} as never, {} as never);
  await svc.listExceptions(USER, { limit: 50, cursor });
  return captured;
}

describe("TimesheetExceptionsService.listExceptions — keyset matches the sort", () => {
  it("orders by created_at desc, then id desc", async () => {
    const { orderBy } = await capture(undefined);
    const rendered = orderBy.map(render);
    expect(rendered[0]).toContain('"created_at"');
    expect(rendered[1]).toContain('"id"');
  });

  it("leading sort column matches the cursor sort column", async () => {
    const { orderBy } = await capture(CURSOR);
    expect(render(orderBy[0])).toContain('"created_at"');
  });

  it("cursor predicate uses row-value strict less-than", async () => {
    const { where } = await capture(CURSOR);
    expect(render(where)).toMatch(/\) < \(\$/);
  });

  it("omits cursor predicate on first page", async () => {
    const { where } = await capture(undefined);
    expect(render(where)).not.toMatch(/\) < \(\$/);
  });

  it("bite proof: an id-only cursor without created_at is what this rejects", () => {
    const badSort = ['"timesheet_exceptions"."id" desc'];
    expect(badSort[0]).not.toContain('"created_at"');
  });
});

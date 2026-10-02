import { PgDialect } from "drizzle-orm/pg-core";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { DataScope } from "../../../access/access.types";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { TICKETS_PERMISSION } from "../lib/tickets-scope";
import { encodeCursor } from "../../../../common/pagination/cursor";
import { projectAccessRow } from "../../__tests__/project-access-doubles";

const dialect = new PgDialect();
const ORG = "org-keyset";
const PROJECT = 1;

const USER: CurrentUserContext = {
  userId: "user-1",
  orgId: ORG,
  role: "EMPLOYEE",
  isOrgOwner: true,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

function render(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

interface Captured {
  where: unknown;
  orderBy: unknown[];
}

function buildDb(captured: Captured): Db {
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
    limit: jest.fn().mockResolvedValueOnce([projectAccessRow()]).mockResolvedValue([]),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  return {
    select: jest.fn().mockReturnValue(builder),
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue({ id: PROJECT, managerId: null }) },
      tickets: { findMany: jest.fn().mockResolvedValue([]) },
    },
  } as unknown as Db;
}

function buildAccess(): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(
      new Map<string, DataScope>([["build:manage", "all"], [TICKETS_PERMISSION, "all"]]),
    ),
    scopeFor: jest.fn().mockResolvedValue("all" as DataScope),
  } as unknown as AccessService;
}

const cursorQuery = (cursor?: string) =>
  ({ page: 1, limit: 10, paging: "cursor", cursor, orderBy: "rank", orderDir: "asc" }) as never;

async function capture(cursor: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = new ProjectsTicketsReadService(
    buildDb(captured),
    buildAccess(),
  );
  await svc.listTickets(USER, PROJECT, cursorQuery(cursor));
  return captured;
}

const TEST_CURSOR = encodeCursor({ sortValue: "00099900", id: "42" });

describe("board keyset — sort column matches the cursor", () => {
  it("orders by rank ASC then id ASC (the two columns the cursor encodes)", async () => {
    const { orderBy } = await capture(undefined);
    const rendered = orderBy.map(render);
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toContain('"rank"');
    expect(rendered[1]).toContain('"id"');
  });

  it("the leading sort column is rank, not a timestamp", async () => {
    const { orderBy } = await capture(TEST_CURSOR);
    const leading = render(orderBy[0]);
    expect(leading).toContain('"rank"');
    expect(leading).not.toContain('"created_at"');
  });

  it("advances the cursor with a strict tuple >, not equality", async () => {
    const { where } = await capture(TEST_CURSOR);
    const sql = render(where);
    expect(sql).toMatch(/"rank".*"id".*>.*\(/);
    expect(sql).not.toMatch(/"rank"\s*=\s*\$\d+/);
  });

  it("omits the cursor predicate entirely on the first page", async () => {
    const { where } = await capture(undefined);
    expect(render(where)).not.toMatch(/"rank".*>.*\(/);
  });

  it("bite proof: a timestamp-leading sort with a rank cursor drops and duplicates rows past page 1", () => {
    const wrongSort = ['"tickets"."created_at" desc', '"tickets"."rank" asc'];
    expect(wrongSort[0]).not.toContain('"rank"');
    expect(wrongSort[1]).not.toContain('"created_at"');
  });
});

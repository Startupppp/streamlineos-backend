/**
 * The board's ORDER BY and the index that is supposed to carry it must agree.
 *
 * THE DEFECT THIS PINS
 * Migration 0575 built one index per sortable ticket column from a single
 * template — (org_id, project_id, <sort col>, created_at DESC, id) — because
 * every `orderBy` branch of `listTickets` sorts `[col, created_at DESC, id]`.
 * Every branch except `rank`: the board sorts `(rank ASC, id ASC)` on purpose,
 * and keysets on the same two columns (see `listTicketsByCursor`'s comment and
 * board-keyset.spec.ts). So `idx_tickets_org_project_rank_sort` was born with
 * `created_at DESC` wedged between `rank` and `id`, carrying an order nothing
 * emits, and every board page Incremental-Sorted the entire project before the
 * LIMIT could discard it — 1,850 index rows read to return 101 on a
 * 1,850-ticket project, five pages auto-loaded per board open, per user.
 *
 * Neither half was wrong in isolation, which is why nothing caught it: the sort
 * is deliberate and spec'd, the index is a faithful copy of the template, and
 * the buffer count stays small (21 blocks) because sorting index tuples is
 * cheap. Only the DISAGREEMENT is the defect, so this is what gets asserted.
 *
 * Hermetic on purpose. `db:check-build-reads` proves the plan on real data with
 * its `forbidSort` assertion, but it needs a seeded database and is not wired
 * into CI; this runs in the ordinary suite and fails on the declaration alone.
 */
import { SQL } from "drizzle-orm";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { tickets } from "../../../db/schema";
import { ProjectsTicketsReadService } from "./tickets/projects-tickets-read.service";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { TICKETS_PERMISSION } from "./tickets/tickets-scope";

const dialect = new PgDialect();
const ORG = "org-rank-index";
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

/** The DB column name of one declared index key. */
function indexColumnName(column: unknown): string {
  if (column !== null && typeof column === "object" && "name" in column && typeof column.name === "string") {
    return column.name;
  }
  throw new Error("a declared index key has no column name");
}

function declaredIndex(name: string): { columns: string[]; isPartial: boolean } {
  const found = getTableConfig(tickets).indexes.find((i) => i.config.name === name);
  if (!found) throw new Error(`build.tickets declares no index named ${name}`);
  return {
    columns: (found.config.columns ?? []).map(indexColumnName),
    isPartial: found.config.where !== undefined,
  };
}

/** The ORDER BY the board actually emits, as rendered column names. */
async function boardSortColumns(): Promise<string[]> {
  const captured: unknown[] = [];
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    where: jest.fn(() => builder),
    orderBy: jest.fn((...cols: unknown[]) => {
      captured.push(...cols);
      return builder;
    }),
    limit: jest.fn().mockResolvedValue([]),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  const db = {
    select: jest.fn().mockReturnValue(builder),
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue({ id: PROJECT, managerId: null }) },
      tickets: { findMany: jest.fn().mockResolvedValue([]) },
    },
  } as unknown as Db;
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(
      new Map<string, DataScope>([["build:manage", "all"], [TICKETS_PERMISSION, "all"]]),
    ),
    scopeFor: jest.fn().mockResolvedValue("all"),
  } as unknown as AccessService;

  const svc = new ProjectsTicketsReadService(db, access);
  await svc.listTickets(USER, PROJECT, {
    page: 1,
    limit: 10,
    paging: "cursor",
    orderBy: "rank",
    orderDir: "asc",
  } as never);

  return captured.map((expression) => {
    if (!(expression instanceof SQL)) throw new Error("an ORDER BY key is not a SQL expression");
    return dialect.sqlToQuery(expression).sql;
  });
}

/** The board index. Its name says (rank, id) because that is what it must carry. */
const BOARD_INDEX = "idx_tickets_org_project_rank_id";

describe("board rank sort — the declared index carries the ORDER BY", () => {
  it("declares an index whose keys are org, project, rank, id (created_at may only trail)", () => {
    const { columns, isPartial } = declaredIndex(BOARD_INDEX);

    expect(columns.slice(0, 4)).toEqual(["org_id", "project_id", "rank", "id"]);
    // org_id leads because the RLS qual is not leakproof: without it the planner
    // refuses an index-only scan outright (backend/CLAUDE.md section 7).
    expect(columns[0]).toBe("org_id");
    // Every board read filters deleted_at IS NULL; a total index would be a
    // different, larger index for the same rows.
    expect(isPartial).toBe(true);
  });

  it("puts nothing between rank and id — the exact defect 1059 reshaped away", () => {
    const { columns } = declaredIndex(BOARD_INDEX);
    const rankAt = columns.indexOf("rank");
    const idAt = columns.indexOf("id");

    expect(rankAt).toBeGreaterThanOrEqual(0);
    expect(idAt).toBe(rankAt + 1);
    expect(columns.slice(rankAt + 1, idAt)).toEqual([]);
  });

  it("the ORDER BY the board emits is a prefix of that index, key for key", async () => {
    const sortKeys = await boardSortColumns();
    const { columns } = declaredIndex(BOARD_INDEX);

    // Both keys ascending, in the index's own direction, so the scan is ordered.
    expect(sortKeys).toHaveLength(2);
    expect(sortKeys[0]).toContain('"rank"');
    expect(sortKeys[0]).not.toMatch(/desc/i);
    expect(sortKeys[1]).toContain('"id"');
    expect(sortKeys[1]).not.toMatch(/desc/i);

    const sorted = sortKeys.map((key) => {
      const match = /"([a-z_]+)"\s*$|"([a-z_]+)"\s+asc/i.exec(key);
      return (match?.[1] ?? match?.[2] ?? key).trim();
    });
    // The equality-bound leading keys, then the sort keys, in order.
    expect(columns.slice(0, 2 + sorted.length)).toEqual(["org_id", "project_id", ...sorted]);
  });

  it("bite proof: the shipped shape put created_at between them, and a prefix check catches it", () => {
    const shipped = ["org_id", "project_id", "rank", "created_at", "id"];
    const rankAt = shipped.indexOf("rank");
    expect(shipped.indexOf("id")).not.toBe(rankAt + 1);
    expect(shipped.slice(0, 4)).not.toEqual(["org_id", "project_id", "rank", "id"]);
  });
});

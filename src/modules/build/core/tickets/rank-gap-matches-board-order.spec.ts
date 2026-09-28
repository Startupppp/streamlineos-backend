import { Column, SQL, isSQLWrapper } from "drizzle-orm";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { AccessService } from "../../../access/access.service";
import type { CacheService } from "../../../../common/cache/cache.service";
import type { Db } from "../../../../db/drizzle.types";
import { rankTicket, rebalanceProjectRanks } from "./projects-tickets-rank-utils";

const actor: CurrentUserContext = {
  orgId: "11111111-1111-4111-8111-111111111111",
  userId: "owner",
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "session",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

const access = { scopeFor: jest.fn().mockResolvedValue("all") } as unknown as AccessService;
const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) } as unknown as CacheService;

function columnNamesIn(
  node: unknown,
  found: Set<string> = new Set(),
  seen: WeakSet<object> = new WeakSet(),
): Set<string> {
  if (typeof node !== "object" || node === null) return found;
  if (seen.has(node)) return found;
  seen.add(node);

  if (node instanceof Column) {
    found.add(node.name);
    return found;
  }
  if (node instanceof SQL) {
    for (const chunk of node.queryChunks) columnNamesIn(chunk, found, seen);
    return found;
  }
  if (Array.isArray(node)) {
    for (const item of node) columnNamesIn(item, found, seen);
    return found;
  }
  if (isSQLWrapper(node)) return columnNamesIn(node.getSQL(), found, seen);
  return found;
}

type CapturedGap = { where: unknown };

function makeDb(captured: CapturedGap, executed: string[]) {
  const boardRows = [
    { id: 7, status: "TODO", rank: "1000", version: 1, assigneeMembershipId: null, dueDate: null, priority: "MEDIUM", points: 1, epicId: null, sprintId: null, allowed: true },
    { id: 4, status: "TODO", rank: "1000", version: 1, assigneeMembershipId: null, dueDate: null, priority: "MEDIUM", points: 1, epicId: null, sprintId: null, allowed: true },
  ];

  interface SelectChain {
    from: jest.Mock;
    where: jest.Mock;
    orderBy: jest.Mock;
    for: jest.Mock;
    limit: jest.Mock;
    then: (resolve: (value: typeof boardRows) => unknown) => Promise<unknown>;
  }

  const db = {
    select: jest.fn(() => {
      let lastWhere: unknown;
      let chain: SelectChain;
      chain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn((condition: unknown) => {
          lastWhere = condition;
          return chain;
        }),
        orderBy: jest.fn().mockReturnThis(),
        for: jest.fn().mockReturnThis(),
        limit: jest.fn(() => {
          captured.where = lastWhere;
          return Promise.resolve([]);
        }),
        then: (resolve: (value: typeof boardRows) => unknown) => Promise.resolve(boardRows).then(resolve),
      };
      return chain;
    }),
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => ({
          returning: jest.fn().mockResolvedValue([{ id: 7, rank: "2000", status: "TODO" }]),
        })),
      })),
    })),
    execute: jest.fn((statement: unknown) => {
      const chunks = statement instanceof SQL ? statement.queryChunks : [];
      executed.push(chunks.map((chunk) => (typeof chunk === "object" && chunk !== null && "value" in chunk ? String((chunk as { value: unknown }).value) : "")).join(""));
      return Promise.resolve([{ rank: "2000", valid: true }]);
    }),
    query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: 1 }) } },
    transaction: jest.fn(),
  };
  db.transaction.mockImplementation(async (callback: (tx: typeof db) => Promise<unknown>) => callback(db));
  return db;
}

describe("the rank write path orders the board the same way the board reads it", () => {
  it("tiebreaks equal ranks on id, never on created_at, so a drop at the end of a column is not a false conflict", async () => {
    const captured: CapturedGap = { where: undefined };
    const db = makeDb(captured, []);

    await rankTicket(db as unknown as Db, cache, access, actor, 1, 7, {
      beforeTicketId: 4,
      afterTicketId: null,
      status: "TODO",
    });

    const columns = columnNamesIn(captured.where);
    expect(columns.has("rank")).toBe(true);
    expect(columns.has("id")).toBe(true);
    expect(columns.has("created_at")).toBe(false);
  });

  it("rebalances into (rank, id) order so a rewrite does not reverse the board", async () => {
    const executed: string[] = [];
    const db = makeDb({ where: undefined }, executed);

    await rebalanceProjectRanks(db as unknown as Db, actor.orgId, 1);

    const rewrite = executed.find((statement) => statement.includes("row_number()"));
    expect(rewrite).toBeDefined();
    expect(rewrite).toContain("ORDER BY rank ASC, id ASC");
    expect(rewrite).not.toContain("created_at");
  });
});

import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import type { DataScope } from "../../access/access.types";
import { TICKETS_PERMISSION } from "./tickets-scope";

const ORG_ID = "org-1";

const makeUser = (overrides: Partial<CurrentUserContext> = {}): CurrentUserContext => ({
  userId: "user-1",
  orgId: ORG_ID,
  role: "EMPLOYEE",
  isOrgOwner: true,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
  ...overrides,
});

function makeRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    title: `Ticket ${i + 1}`,
    status: "TODO",
    rank: String((i + 1) * 1000),
    assigneeId: null,
    reporterId: null,
    projectId: 1,
  }));
}

describe("board query count is bounded and independent of card count", () => {
  function buildHarness(rowCount: number) {
    let queries = 0;
    const rows = makeRows(rowCount);

    const countingChain = (result: unknown): Record<string, unknown> => {
      const chain: Record<string, unknown> = {};
      for (const method of ["from", "where", "innerJoin", "leftJoin", "orderBy", "groupBy"])
        chain[method] = jest.fn(() => chain);
      chain["limit"] = jest.fn(() => chain);
      chain["offset"] = jest.fn(() => Promise.resolve(result));
      chain["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return chain;
    };

    const db = {
      select: jest.fn(() => {
        queries += 1;
        return countingChain([{ total: rowCount }]);
      }),
      execute: jest.fn(() => {
        queries += 1;
        return Promise.resolve(rows.map((r) => ({ id: r.id })));
      }),
      query: {
        projects: {
          findFirst: jest.fn(() => {
            queries += 1;
            return Promise.resolve({ id: 1, orgId: ORG_ID });
          }),
        },
        tickets: {
          findMany: jest.fn(() => {
            queries += 1;
            return Promise.resolve(rows);
          }),
        },
      },
    } as unknown as Db;

    const access = {
      resolveUserPermissions: jest.fn(() =>
        Promise.resolve(new Map<string, DataScope>([[TICKETS_PERMISSION, "all"]])),
      ),
    } as unknown as AccessService;

    const audit = { log: jest.fn() } as unknown as AuditService;

    return {
      svc: new ProjectsTicketsReadService(db, access),
      getQueries: () => queries,
    };
  }

  const listQuery = {
    page: 1,
    limit: 100,
    orderBy: "rank" as const,
    orderDir: "asc" as const,
  };

  it("issues the same number of queries for 3 cards as for 500", async () => {
    const small = buildHarness(3);
    const large = buildHarness(500);

    await small.svc
      .listTickets(makeUser(), 1, listQuery as never)
      .catch(() => undefined);
    await large.svc
      .listTickets(makeUser(), 1, listQuery as never)
      .catch(() => undefined);

    expect(large.getQueries()).toBe(small.getQueries());
  });

  it("stays within the bounded budget for a board load", async () => {
    const BOARD_QUERY_BUDGET = 6;
    const harness = buildHarness(500);

    await harness.svc
      .listTickets(makeUser(), 1, listQuery as never)
      .catch(() => undefined);

    expect(harness.getQueries()).toBeLessThanOrEqual(BOARD_QUERY_BUDGET);
  });
});

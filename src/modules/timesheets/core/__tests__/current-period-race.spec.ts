import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";
import { PeriodsService } from "../periods.service";

const ORG = "org-current";
const USER: CurrentUserContext = {
  userId: "user-1",
  orgId: ORG,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(5, false),
};

function harness(opts: { existsOnFirstRead: boolean; insertWins: boolean }) {
  let selects = 0;
  const insertValues: Record<string, unknown>[] = [];
  let conflictTarget: unknown;
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            selects += 1;
            if (selects === 1) return opts.existsOnFirstRead ? [{ id: 11 }] : [];
            return [{ id: 12 }];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        insertValues.push(row);
        return {
          onConflictDoNothing: (config: { target: unknown }) => {
            conflictTarget = config.target;
            return { returning: async () => (opts.insertWins ? [{ id: 13 }] : []) };
          },
        };
      },
    }),
    query: { timesheets: { findMany: async () => [] } },
  } as unknown as Db;
  const reader = {
    getSettings: async () => ({ workWeekStart: 1 }),
    getPeriodWithUser: async (_org: string, id: number) => ({ id, userMembershipId: 5, status: "OPEN" }),
    listPeriodEntries: async () => [],
    mapPeriod: (row: unknown) => row,
  };
  // Last arg is ApprovalsService; this spec drives getOrCreatePeriod only.
  const service = new PeriodsService(db, reader as never, {} as never, {} as never, {} as never, {} as never);
  return { service, insertValues, selects: () => selects, conflictTarget: () => conflictTarget };
}

describe("the current period under a concurrent first request", () => {
  it("reuses the week that already exists without inserting", async () => {
    const h = harness({ existsOnFirstRead: true, insertWins: true });

    const result = await h.service.getCurrent(USER);

    expect(result.period).toMatchObject({ id: 11 });
    expect(h.insertValues).toHaveLength(0);
  });

  it("creates the week when nobody has, keyed on the tenant, the member and the range", async () => {
    const h = harness({ existsOnFirstRead: false, insertWins: true });

    const result = await h.service.getCurrent(USER);

    expect(result.period).toMatchObject({ id: 13 });
    expect(h.insertValues[0]).toMatchObject({ orgId: ORG, userMembershipId: 5, status: "OPEN" });
    expect(Array.isArray(h.conflictTarget())).toBe(true);
    expect(h.conflictTarget()).toHaveLength(4);
  });

  it("yields to the request that won the race and reads its row back instead of failing", async () => {
    const h = harness({ existsOnFirstRead: false, insertWins: false });

    const result = await h.service.getCurrent(USER);

    expect(result.period).toMatchObject({ id: 12 });
    expect(h.selects()).toBe(2);
  });
});

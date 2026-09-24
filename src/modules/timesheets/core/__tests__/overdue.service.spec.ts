import { TimesheetOverdueService } from "../overdue.service";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { OverdueQuery } from "../dto/overdue.schemas";
import { humanSessionPrincipal } from "../../../../common/auth/principal";

const USER = { orgId: "org-1", userId: "usr-1", principal: humanSessionPrincipal(1, false) } as unknown as CurrentUserContext;

const PERIOD = {
  id: 11,
  userId: "usr-worker",
  userMembershipId: 21,
  periodStart: "2026-04-01",
  periodEnd: "2026-04-30",
  status: "OPEN",
  totalHours: "12.00",
  userName: "Asha",
  userEmail: "asha@example.test",
  windowTotal: "1",
};

function stubDb(settingsRow: unknown, periodRows: unknown[]) {
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          const p = Promise.resolve(periodRows) as Promise<unknown[]> & {
            limit: (n: number) => Promise<unknown[]>;
            orderBy: () => { limit: () => { offset: () => Promise<unknown[]> } };
          };
          p.limit = async () => (settingsRow ? [settingsRow] : []);
          p.orderBy = () => ({ limit: () => ({ offset: async () => periodRows }) });
          return p;
        },
        leftJoin: function join(): unknown {
          return {
            leftJoin: join,
            where: () => ({
              orderBy: () => ({ limit: () => ({ offset: async () => periodRows }) }),
            }),
          };
        },
      }),
    }),
  } as unknown as Db;
  return db;
}

const access = {} as unknown as AccessService;

jest.mock("../timesheets-core-scope", () => {
  const { ScopedRead } = jest.requireActual<typeof import("../../../access/scoped-read")>(
    "../../../access/scoped-read",
  );
  return {
    ...jest.requireActual("../timesheets-core-scope"),
    resolveApprovalScope: async (_access: unknown, u: { orgId: string; userId: string }) =>
      ScopedRead.of(u.orgId, u.userId, "all"),
  };
});

const query = (overrides: Partial<OverdueQuery> = {}): OverdueQuery =>
  ({ page: 1, limit: 50, ...overrides }) as OverdueQuery;

describe("TimesheetOverdueService", () => {
  it("dates from period end plus the grace, and counts days overdue from there", async () => {
    const db = stubDb(
      { reminderRules: { enabled: true, remindBeforeDueDays: [], remindAfterDueDays: [] }, submissionGraceDays: 5 },
      [PERIOD],
    );
    const service = new TimesheetOverdueService(db, access);

    const result = await service.listOverdue(USER, query({ asOf: "2026-05-10" }));

    expect(result.graceDays).toBe(5);
    expect(result.items[0]).toMatchObject({ dueDate: "2026-05-05", daysOverdue: 5 });
  });

  it("counts only the escalation thresholds the period has actually crossed", async () => {
    const db = stubDb(
      {
        reminderRules: { enabled: true, remindBeforeDueDays: [], remindAfterDueDays: [1, 3, 7] },
        submissionGraceDays: 0,
      },
      [PERIOD],
    );
    const service = new TimesheetOverdueService(db, access);

    const result = await service.listOverdue(USER, query({ asOf: "2026-05-04" }));

    expect(result.escalationThresholds).toEqual([1, 3, 7]);
    expect(result.items[0]!.escalationLevel).toBe(2);
  });

  it("reports level 0 with no thresholds when the organisation configured none", async () => {
    const db = stubDb({ reminderRules: null, submissionGraceDays: 0 }, [PERIOD]);
    const service = new TimesheetOverdueService(db, access);

    const result = await service.listOverdue(USER, query({ asOf: "2026-05-04" }));

    expect(result.escalationThresholds).toEqual([]);
    expect(result.items[0]).toMatchObject({ escalationLevel: 0, daysOverdue: 4 });
  });

  it("still lists overdue periods when the stored reminder rules do not parse", async () => {
    const db = stubDb({ reminderRules: { every: "friday" }, submissionGraceDays: 2 }, [PERIOD]);
    const service = new TimesheetOverdueService(db, access);

    const result = await service.listOverdue(USER, query({ asOf: "2026-05-04" }));

    expect(result.escalationThresholds).toEqual([]);
    expect(result.items).toHaveLength(1);
  });

  it("returns an empty queue rather than failing when nothing is late", async () => {
    const db = stubDb({ reminderRules: null, submissionGraceDays: 0 }, []);
    const service = new TimesheetOverdueService(db, access);

    const result = await service.listOverdue(USER, query({ asOf: "2026-05-04" }));

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });
});

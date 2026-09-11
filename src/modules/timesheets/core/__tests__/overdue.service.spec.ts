import { TimesheetOverdueService } from "../overdue.service";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { OverdueQuery } from "../dto/overdue.schemas";
import { humanSessionPrincipal } from "../../../../common/auth/principal";

/**
 * TS-11. The escalation arithmetic, and the cutoff that keeps it a range scan.
 *
 * `submission_grace_days` and `reminder_rules` were read by the nightly sweep
 * and by nothing else, so an approver had no way to see who was late — the
 * people themselves got an email and that was the whole feature. This is the
 * same arithmetic served as a list, and these are the parts of it that are easy
 * to get subtly wrong:
 *
 *   - the due date is `period_end + grace`, not `period_end`;
 *   - the escalation level counts *crossed* thresholds, so an organisation that
 *     configured none gets 0 rather than a made-up number, and the response
 *     says which thresholds exist so a caller can tell those two cases apart;
 *   - the SQL cutoff must exclude a period that is due *today*, because due
 *     today is not yet late.
 */

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
        // The page read joins the owner's membership and then users; each join returns the same chain.
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

/** `resolveApprovalScope` is a free function over AccessService; stub its answer. */
jest.mock("../timesheets-core-scope", () => ({
  ...jest.requireActual("../timesheets-core-scope"),
  resolveApprovalScope: async () => "all",
}));

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

    /** Ends 04-30, grace 5 -> due 05-05; 05-10 is five days past it. */
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

    /** Due 04-30; 05-04 is four days past, so 1 and 3 are crossed and 7 is not. */
    const result = await service.listOverdue(USER, query({ asOf: "2026-05-04" }));

    expect(result.escalationThresholds).toEqual([1, 3, 7]);
    expect(result.items[0]!.escalationLevel).toBe(2);
  });

  /**
   * Level 0 has to be readable two ways, and the response has to disambiguate
   * them: nothing crossed yet, versus an organisation that configured no
   * escalation at all. `escalationThresholds` being empty is the second case.
   */
  it("reports level 0 with no thresholds when the organisation configured none", async () => {
    const db = stubDb({ reminderRules: null, submissionGraceDays: 0 }, [PERIOD]);
    const service = new TimesheetOverdueService(db, access);

    const result = await service.listOverdue(USER, query({ asOf: "2026-05-04" }));

    expect(result.escalationThresholds).toEqual([]);
    expect(result.items[0]).toMatchObject({ escalationLevel: 0, daysOverdue: 4 });
  });

  /**
   * Unparseable stored rules must not take the queue down with them — the same
   * forgiving read the sweep uses. The list is still useful without the
   * escalation layer; a 500 is not.
   */
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

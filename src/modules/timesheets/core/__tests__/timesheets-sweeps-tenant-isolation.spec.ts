import { organizationMembers, timesheetPeriods, timesheetSettings, timesheets } from "../../../../db/schema";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { forEachOrg } from "../../../../common/tenant/for-each-org";
import { tenantDb, type TenantFixture } from "../../../../test/tenant-recorder";
import type { AccessService } from "../../../access/access.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { AttendanceDraftService } from "../attendance/attendance-draft.service";
import type { TimesheetAttendancePort } from "../attendance/attendance.port";
import type { EntriesPeriodService } from "../entries-period.service";
import type { TimesheetsAuditService } from "../timesheets-audit.service";
import { TimesheetOverdueService } from "../overdue.service";
import { TimesheetRemindersSweepService } from "../reminders-sweep.service";

jest.mock("../../../../common/tenant/for-each-org", () => ({ forEachOrg: jest.fn() }));

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

const userIn = (orgId: string, membershipId: number): CurrentUserContext =>
  ({
    orgId,
    userId: `usr-${orgId}`,
    principal: humanSessionPrincipal(membershipId, false),
  }) as unknown as CurrentUserContext;

describe("AttendanceDraftService — cross-tenant isolation", () => {
  const RANGE = { start: "2026-05-01", end: "2026-05-07" };
  const SEGMENT = {
    date: "2026-05-04",
    startedAt: "2026-05-04T09:00:00.000Z",
    endedAt: "2026-05-04T17:00:00.000Z",
    breakMinutes: 30,
    netMinutes: 450,
    autoCheckedOut: false,
  };
  const optedIn = (orgId: string) => ({ orgId, autoDraft: true, workWeekStart: 1 });

  function build(settingsRows: Array<Record<string, unknown>>) {
    const fixtures: TenantFixture[] = [
      { table: timesheetSettings, org: timesheetSettings.orgId, rows: settingsRows },
    ];
    const store = tenantDb({ fixtures });
    const port = { getClockSegments: jest.fn().mockResolvedValue([SEGMENT]) };
    const periods = {
      getOrCreatePeriod: jest.fn().mockResolvedValue(77),
      recomputePeriodTotals: jest.fn().mockResolvedValue(undefined),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new AttendanceDraftService(
      store.db,
      port as unknown as TimesheetAttendancePort,
      periods as unknown as EntriesPeriodService,
      audit as unknown as TimesheetsAuditService,
    );
    return { store, port, periods, service };
  }

  it("deny: another org's opt-in does not switch drafting on for the caller (different org isolation)", async () => {
    const t = build([optedIn(OWNER_ORG)]);

    const result = await t.service.draftForUser(userIn(ATTACKER_ORG, 2), RANGE);

    expect(result.enabled).toBe(false);
    expect(t.port.getClockSegments).not.toHaveBeenCalled();
    expect(t.store.on(timesheets, "insert")).toHaveLength(0);
    const [policyRead] = t.store.on(timesheetSettings, "select");
    expect(t.store.orgBound(policyRead, timesheetSettings.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: an opted-in caller's clock, periods and entries are all the caller's own org", async () => {
    const t = build([optedIn(OWNER_ORG), optedIn(ATTACKER_ORG)]);

    const result = await t.service.draftForUser(userIn(ATTACKER_ORG, 2), RANGE);

    expect(result.entriesCreated).toBe(1);
    expect(t.port.getClockSegments).toHaveBeenCalledWith(ATTACKER_ORG, `usr-${ATTACKER_ORG}`, RANGE);
    expect(t.periods.getOrCreatePeriod).toHaveBeenCalledWith(ATTACKER_ORG, 2, SEGMENT.date, 1);
    expect(t.periods.recomputePeriodTotals).toHaveBeenCalledWith(ATTACKER_ORG, 77);
    expect(t.store.inserted(timesheets).map((row) => row.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("control: the owning org's opt-in drafts its own entry", async () => {
    const t = build([optedIn(OWNER_ORG)]);

    const result = await t.service.draftForUser(userIn(OWNER_ORG, 1), RANGE);

    expect(result).toMatchObject({ enabled: true, segmentsFound: 1, entriesCreated: 1 });
    expect(t.store.inserted(timesheets)).toEqual([
      expect.objectContaining({ orgId: OWNER_ORG, userMembershipId: 1, date: SEGMENT.date }),
    ]);
  });
});

describe("TimesheetOverdueService — cross-tenant isolation", () => {
  const OWNER_PERIOD = {
    orgId: OWNER_ORG,
    id: 11,
    userMembershipId: 21,
    userId: "usr-owner-worker",
    periodStart: "2026-04-01",
    periodEnd: "2026-04-30",
    status: "OPEN",
    totalHours: "12.00",
    userName: "Asha",
    userEmail: "asha@owner.test",
    windowTotal: "1",
  };
  const settingsFor = (orgId: string) => ({
    orgId,
    reminderRules: { enabled: true, remindBeforeDueDays: [], remindAfterDueDays: [1, 3] },
    submissionGraceDays: 0,
  });

  function build() {
    const store = tenantDb({
      fixtures: [
        { table: timesheetSettings, org: timesheetSettings.orgId, rows: [settingsFor(OWNER_ORG)] },
        { table: timesheetPeriods, org: timesheetPeriods.orgId, rows: [OWNER_PERIOD] },
        {
          table: organizationMembers,
          org: organizationMembers.orgId,
          rows: [{ orgId: OWNER_ORG, id: 21, userId: "usr-owner-worker" }],
        },
      ],
    });
    const access = { scopeFor: jest.fn().mockResolvedValue("all") } as unknown as AccessService;
    return { store, service: new TimesheetOverdueService(store.db, access) };
  }

  it("deny: the overdue queue shows the attacker none of another org's late periods", async () => {
    const t = build();

    const result = await t.service.listOverdue(userIn(ATTACKER_ORG, 2), {
      page: 1,
      limit: 50,
      asOf: "2026-05-10",
    } as never);

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    const [periodRead] = t.store.on(timesheetPeriods, "select");
    expect(t.store.orgBound(periodRead, timesheetPeriods.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: a userId filter naming another org's worker resolves no membership in the caller's org", async () => {
    const t = build();

    const result = await t.service.listOverdue(userIn(ATTACKER_ORG, 2), {
      page: 1,
      limit: 50,
      asOf: "2026-05-10",
      userId: "usr-owner-worker",
    } as never);

    expect(result.items).toEqual([]);
    const [memberLookup] = t.store.on(organizationMembers, "select");
    expect(t.store.orgBound(memberLookup, organizationMembers.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("control: the owning org sees its own overdue period", async () => {
    const t = build();

    const result = await t.service.listOverdue(userIn(OWNER_ORG, 1), {
      page: 1,
      limit: 50,
      asOf: "2026-05-10",
    } as never);

    expect(result.items).toEqual([
      expect.objectContaining({ periodId: 11, userId: "usr-owner-worker", daysOverdue: 10 }),
    ]);
    const [periodRead] = t.store.on(timesheetPeriods, "select");
    expect(t.store.orgBound(periodRead, timesheetPeriods.orgId)).toEqual([OWNER_ORG]);
  });
});

describe("TimesheetRemindersSweepService — cross-tenant isolation", () => {
  const ENABLED = { enabled: true, remindBeforeDueDays: [2], remindAfterDueDays: [1] };
  const OWNER_PERIOD = {
    orgId: OWNER_ORG,
    id: 11,
    userMembershipId: 21,
    userId: "usr-owner-worker",
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
  };
  const settingsFor = (orgId: string) => ({ orgId, reminderRules: ENABLED, submissionGraceDays: 5 });

  function build(settingsRows: Array<Record<string, unknown>>) {
    const store = tenantDb({
      fixtures: [
        { table: timesheetSettings, org: timesheetSettings.orgId, rows: settingsRows },
        { table: timesheetPeriods, org: timesheetPeriods.orgId, rows: [OWNER_PERIOD] },
      ],
    });
    const emit = jest.fn().mockResolvedValue({ notified: 1 });
    const notifications = { emit } as unknown as NotificationDispatchService;
    return { store, emit, service: new TimesheetRemindersSweepService(store.db, notifications) };
  }

  it("deny: a caller org with no settings of its own is not swept on another org's rules", async () => {
    const t = build([settingsFor(OWNER_ORG)]);

    expect(await t.service.remindOrg(ATTACKER_ORG, "2026-04-03")).toBeNull();
    expect(t.emit).not.toHaveBeenCalled();
    const [settingsRead] = t.store.on(timesheetSettings, "select");
    expect(t.store.orgBound(settingsRead, timesheetSettings.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: the sweep of one org reminds nobody about another org's unsubmitted period", async () => {
    const t = build([settingsFor(OWNER_ORG), settingsFor(ATTACKER_ORG)]);

    const result = await t.service.remindOrg(ATTACKER_ORG, "2026-04-03");

    expect(result).toMatchObject({ periodsConsidered: 0, remindersSent: 0 });
    expect(t.emit).not.toHaveBeenCalled();
    const [periodRead] = t.store.on(timesheetPeriods, "select");
    expect(t.store.orgBound(periodRead, timesheetPeriods.orgId)).toEqual([ATTACKER_ORG]);
    expect(t.store.orgBound({ ...periodRead!, where: periodRead!.joins }, organizationMembers.orgId)).toEqual([
      ATTACKER_ORG,
    ]);
  });

  it("deny: remindAllOrgs hands each enumerated org only its own periods", async () => {
    const t = build([settingsFor(OWNER_ORG), settingsFor(ATTACKER_ORG)]);
    (forEachOrg as jest.Mock).mockImplementation(
      async (_db: unknown, _sweep: string, fn: (tx: unknown, orgId: string) => Promise<void>) => {
        for (const orgId of [ATTACKER_ORG, OWNER_ORG]) await fn(t.store.db, orgId);
        return { succeeded: 2, failed: 0 };
      },
    );

    const result = await t.service.remindAllOrgs("2026-04-03");

    expect(result).toMatchObject({ orgsScanned: 2, periodsConsidered: 1, remindersSent: 1 });
    expect(t.emit).toHaveBeenCalledTimes(1);
    expect(t.emit.mock.calls[0]![0]).toMatchObject({
      orgId: OWNER_ORG,
      targetUserIds: ["usr-owner-worker"],
    });
  });

  it("control: the owning org's due period earns its own worker a reminder", async () => {
    const t = build([settingsFor(OWNER_ORG)]);

    const result = await t.service.remindOrg(OWNER_ORG, "2026-04-03");

    expect(result).toMatchObject({ periodsConsidered: 1, remindersSent: 1 });
    expect(t.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: OWNER_ORG,
        eventKey: "timesheets.period.due_soon",
        targetUserIds: ["usr-owner-worker"],
      }),
    );
  });
});

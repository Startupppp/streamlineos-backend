import type { Db } from "../../db/drizzle.module";
import type { TenantTx } from "../../db/drizzle.types";
import { forEachOrg } from "../../common/tenant/for-each-org";
import { CronRecruitmentSlaService, RECRUITMENT_SLA_RUN_BUDGET } from "./cron-recruitment-sla.service";
import {
  CronRecruitmentReportsService,
  RECRUITMENT_REPORTS_RUN_BUDGET,
} from "./cron-recruitment-reports.service";
import {
  ESCALATION_RUN_BUDGET,
  TimesheetApprovalEscalationSweepService,
} from "../timesheets/core/approval-escalation-sweep.service";
import type { EmailService } from "../email/email.service";
import type { HrRecruitmentReportsService } from "../hr/interviews/hr-recruitment-reports.service";
import type { TimesheetApprovalRoutingService } from "../timesheets/core/approval-routing.service";
import type { TimesheetsAuditService } from "../timesheets/core/timesheets-audit.service";
import type { NotificationDispatchService } from "../notifications/notification-dispatch.service";

jest.mock("../../common/tenant/for-each-org", () => ({
  ...jest.requireActual("../../common/tenant/for-each-org"),
  forEachOrg: jest.fn(),
}));

const ORGS = ["org-a", "org-b", "org-c"];
const visited: string[] = [];

function chain(result: unknown) {
  const node: Record<string, unknown> = {};
  for (const key of ["select", "from", "where", "update", "set", "limit", "returning"])
    node[key] = () => node;
  node.then = (resolve: (value: unknown) => unknown) => resolve(result);
  return node;
}

function fakeTx(selected: unknown[], updated: unknown[]): TenantTx {
  const handle = {
    select: () => chain(selected),
    update: () => chain(updated),
  };
  return handle as unknown as TenantTx;
}

beforeEach(() => {
  visited.length = 0;
  jest.mocked(forEachOrg).mockImplementation(async (_db, _sweep, fn, _intent, options = {}) => {
    const start = options.startAfterOrgId ? ORGS.indexOf(options.startAfterOrgId) + 1 : 0;
    const order = [...ORGS.slice(start), ...ORGS.slice(0, start)];
    let organizations = 0;
    for (const orgId of order) {
      if (options.stopWhen?.()) break;
      organizations += 1;
      visited.push(orgId);
      await fn(currentTx(), orgId);
    }
    return { organizations, succeeded: organizations, failed: 0, transientFailures: 0, failedOrgIds: [] };
  });
});

let currentTx: () => TenantTx = () => fakeTx([], []);
const db = {} as Db;

describe("periodic sweeps stop at their run budget and resume after the last tenant they reached", () => {
  it("the SLA sweep stops once it has moved a budget of candidates and the next run starts at the next tenant", async () => {
    const half = Array.from({ length: RECRUITMENT_SLA_RUN_BUDGET / 2 }, (_, id) => ({ id }));
    currentTx = () => fakeTx([{ stage: "NEW", maxHours: 1, warningHours: 1 }], half);
    const service = new CronRecruitmentSlaService(db);

    const first = await service.sweepStageSlas();
    expect(first.breached + first.atRisk).toBe(RECRUITMENT_SLA_RUN_BUDGET);
    expect(visited).toEqual(["org-a"]);

    await service.sweepStageSlas();
    expect(visited).toEqual(["org-a", "org-b"]);
  });

  it("the SLA sweep walks every tenant from the start when the budget is never reached", async () => {
    currentTx = () => fakeTx([{ stage: "NEW", maxHours: 1, warningHours: 1 }], [{ id: 1 }]);
    const service = new CronRecruitmentSlaService(db);

    await service.sweepStageSlas();
    await service.sweepStageSlas();
    expect(visited).toEqual([...ORGS, ...ORGS]);
  });

  it("the scheduled-report sweep stops once it has attempted a budget of deliveries", async () => {
    const due = Array.from({ length: RECRUITMENT_REPORTS_RUN_BUDGET }, (_, id) => ({
      id,
      name: `r${id}`,
      reportConfig: {},
      schedule: "WEEKLY",
      recipients: ["a@example.com"],
    }));
    currentTx = () => fakeTx(due, []);
    const email = { sendEmail: jest.fn().mockResolvedValue(undefined) };
    const reports = { generateReport: jest.fn().mockResolvedValue({ rows: [], total: 0 }) };
    const service = new CronRecruitmentReportsService(
      db,
      email as unknown as EmailService,
      reports as unknown as HrRecruitmentReportsService,
    );

    const first = await service.deliverDueReports();
    expect(first.delivered).toBe(RECRUITMENT_REPORTS_RUN_BUDGET);
    expect(visited).toEqual(["org-a"]);

    await service.deliverDueReports();
    expect(visited).toEqual(["org-a", "org-b"]);
  });

  it("the timesheet escalation sweep stops once it has seen a budget of overdue periods", async () => {
    const service = new TimesheetApprovalEscalationSweepService(
      db,
      {} as TimesheetApprovalRoutingService,
      {} as TimesheetsAuditService,
      {} as NotificationDispatchService,
    );
    jest.spyOn(service, "escalateOrg").mockResolvedValue({
      periodsOverdue: ESCALATION_RUN_BUDGET,
      periodsEscalated: 0,
      periodsUnowned: 0,
    });

    const first = await service.escalateAllOrgs();
    expect(first.orgsScanned).toBe(1);
    expect(visited).toEqual(["org-a"]);

    await service.escalateAllOrgs();
    expect(visited).toEqual(["org-a", "org-b"]);
  });
});

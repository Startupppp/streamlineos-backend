import { humanSessionPrincipal, agentTokenPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DirectReportsService, DirectReport } from "../../directory/direct-reports.service";
import type { ApprovalsService } from "../../timesheets/core/approvals.service";
import type { PeriodsReadService } from "../../timesheets/core/periods-read.service";
import type { LeavesService } from "../time/leaves.service";
import type { WfhService } from "../time/wfh.service";
import type { HrWorkflowInstancesService } from "../workflows/hr-workflow-instances.service";
import { ManagerHomeService } from "./manager-home.service";

const NOW = new Date("2026-09-21T09:00:00.000Z");

const MANAGER = {
  userId: "usr-manager",
  orgId: "org-1",
  isOrgOwner: false,
  principal: humanSessionPrincipal(77, false),
} as unknown as CurrentUserContext;

function report(overrides: Partial<DirectReport> = {}): DirectReport {
  return {
    userId: "usr-asha",
    membershipId: 11,
    employmentId: 101,
    name: "Asha",
    email: "asha@example.test",
    designation: "Engineer",
    joiningDate: "2026-08-01",
    probationEndDate: null,
    lifecycleStatus: "ACTIVE",
    ...overrides,
  };
}

interface Doubles {
  reports?: DirectReport[];
  leave?: unknown[];
  wfh?: unknown[];
  timesheets?: unknown[];
  workflows?: { data: unknown[]; total: number };
  unsettled?: unknown[];
  availability?: unknown[];
}

function service(doubles: Doubles = {}) {
  const calls: Record<string, unknown[][]> = { leave: [], wfh: [], timesheets: [], workflows: [], unsettled: [], availability: [] };
  const svc = new ManagerHomeService(
    { list: () => Promise.resolve(doubles.reports ?? []) } as unknown as DirectReportsService,
    {
      pendingRoutedTo: (...args: unknown[]) => {
        calls.leave.push(args);
        return Promise.resolve(doubles.leave ?? []);
      },
      teamAvailability: (...args: unknown[]) => {
        calls.availability.push(args);
        return Promise.resolve(doubles.availability ?? []);
      },
    } as unknown as LeavesService,
    {
      pendingRoutedTo: (...args: unknown[]) => {
        calls.wfh.push(args);
        return Promise.resolve(doubles.wfh ?? []);
      },
    } as unknown as WfhService,
    {
      pendingRoutedTo: (...args: unknown[]) => {
        calls.timesheets.push(args);
        return Promise.resolve(doubles.timesheets ?? []);
      },
    } as unknown as ApprovalsService,
    {
      unsettledForMembers: (...args: unknown[]) => {
        calls.unsettled.push(args);
        return Promise.resolve(doubles.unsettled ?? []);
      },
    } as unknown as PeriodsReadService,
    {
      getInbox: (...args: unknown[]) => {
        calls.workflows.push(args);
        return Promise.resolve(doubles.workflows ?? { data: [], total: 0 });
      },
    } as unknown as HrWorkflowInstancesService,
  );
  return { svc, calls };
}

describe("ManagerHomeService — one task-oriented view for a reporting manager", () => {
  it("tells a member with no direct reports they are not a manager, without asking any team question", async () => {
    const { svc, calls } = service();

    const home = await svc.getHome(MANAGER, NOW);

    expect(home.isManager).toBe(false);
    expect(home.reports).toEqual([]);
    expect(home.approvals).toEqual({ leave: 0, wfh: 0, timesheets: 0, workflows: 0, items: [] });
    expect(calls.availability).toEqual([]);
    expect(calls.unsettled).toEqual([["org-1", [], "2026-09-21", 100]]);
  });

  it("asks every queue for the requests routed to the manager's membership, and merges them oldest first", async () => {
    const { svc, calls } = service({
      reports: [report()],
      leave: [
        {
          id: 5,
          userId: "usr-asha",
          startDate: "2026-09-28",
          endDate: "2026-09-29",
          isHalfDay: false,
          createdAt: new Date("2026-09-20T10:00:00.000Z"),
          user: { name: "Asha", email: "asha@example.test" },
          leaveType: { name: "Casual leave" },
        },
      ],
      wfh: [
        {
          id: 9,
          userId: "usr-asha",
          date: "2026-09-23",
          createdAt: new Date("2026-09-19T10:00:00.000Z"),
          userName: null,
          userFirstName: "Asha",
          userLastName: "K",
          userEmail: "asha@example.test",
        },
      ],
      timesheets: [
        {
          id: 42,
          userMembershipId: 11,
          userName: "Asha",
          userEmail: "asha@example.test",
          periodStart: "2026-09-07",
          periodEnd: "2026-09-13",
          totalHours: "38.50",
          submittedAt: new Date("2026-09-14T09:00:00.000Z"),
          approvalDueAt: new Date("2026-09-16T09:00:00.000Z"),
          approvalRoute: null,
        },
      ],
      workflows: {
        data: [{ id: 3, subjectEmployeeId: "usr-asha", objectType: "expense_reimbursement", currentStepOrder: 1, createdAt: new Date("2026-09-21T08:00:00.000Z"), dueAt: null }],
        total: 1,
      },
    });

    const home = await svc.getHome(MANAGER, NOW);

    expect(calls.leave).toEqual([["org-1", 77, 20]]);
    expect(calls.wfh).toEqual([["org-1", 77, 20]]);
    expect(calls.timesheets).toEqual([["org-1", 77, 20]]);
    expect(calls.workflows).toEqual([[MANAGER, 1, 20]]);
    expect(home.isManager).toBe(true);
    expect(home.approvals).toMatchObject({ leave: 1, wfh: 1, timesheets: 1, workflows: 1 });
    expect(home.approvals.items.map((item) => [item.kind, item.subjectName, item.summary, item.href])).toEqual([
      ["timesheet", "Asha", "Timesheet · 2026-09-07 to 2026-09-13 · 38.5h", "/timesheets/approvals?period=42"],
      ["wfh", "Asha K", "Work from home · 2026-09-23", "/hr/leaves"],
      ["leave", "Asha", "Casual leave · 2026-09-28 to 2026-09-29", "/hr/leaves"],
      ["workflow", null, "expense reimbursement · step 1", "/hr/approvals"],
    ]);
    expect(home.approvals.items[0]).toMatchObject({ subjectUserId: "usr-asha", dueAt: new Date("2026-09-16T09:00:00.000Z") });
  });

  it("marks who is on leave today, counts each report's unsettled timesheets and lists them by period", async () => {
    const { svc, calls } = service({
      reports: [report(), report({ userId: "usr-ben", membershipId: 12, employmentId: 102, name: "Ben" })],
      availability: [
        { userId: "usr-asha", displayName: "Asha", startDate: "2026-09-20", endDate: "2026-09-22", leaveTypeId: 1, status: "APPROVED" },
        { userId: "usr-ben", displayName: "Ben", startDate: "2026-09-28", endDate: "2026-09-28", leaveTypeId: 2, status: "APPROVED" },
        { userId: "usr-stranger", displayName: "Stranger", startDate: "2026-09-21", endDate: "2026-09-21", leaveTypeId: 1, status: "APPROVED" },
      ],
      unsettled: [
        { id: 30, userMembershipId: 12, periodStart: "2026-09-07", periodEnd: "2026-09-13", status: "OPEN", totalHours: "0" },
        { id: 31, userMembershipId: 12, periodStart: "2026-09-14", periodEnd: "2026-09-20", status: "REJECTED", totalHours: "8" },
      ],
    });

    const home = await svc.getHome(MANAGER, NOW);

    // HRMS-E2E-021: the read is narrowed to the reports in SQL, and each row carries its real status.
    expect(calls.availability[0]?.[3]).toEqual(["usr-asha", "usr-ben"]);
    expect(home.upcomingLeave.map((row) => row.status)).toEqual(["APPROVED", "APPROVED"]);
    expect(home.reports.map((row) => [row.name, row.onLeaveToday, row.unsettledTimesheets])).toEqual([
      ["Asha", true, 0],
      ["Ben", false, 2],
    ]);
    expect(home.upcomingLeave.map((row) => row.userId)).toEqual(["usr-asha", "usr-ben"]);
    expect(home.missingTimesheets).toEqual([
      { periodId: 30, userId: "usr-ben", name: "Ben", periodStart: "2026-09-07", periodEnd: "2026-09-13", status: "OPEN" },
      { periodId: 31, userId: "usr-ben", name: "Ben", periodStart: "2026-09-14", periodEnd: "2026-09-20", status: "REJECTED" },
    ]);
  });

  it("surfaces probation ending within thirty days, soonest first, and nothing for confirmed staff", async () => {
    const { svc } = service({
      reports: [
        report({ userId: "usr-a", membershipId: 1, name: "A", lifecycleStatus: "PROBATION", probationEndDate: "2026-10-15" }),
        report({ userId: "usr-b", membershipId: 2, name: "B", lifecycleStatus: "PROBATION", probationEndDate: "2026-09-25" }),
        report({ userId: "usr-c", membershipId: 3, name: "C", lifecycleStatus: "PROBATION", probationEndDate: "2026-12-01" }),
        report({ userId: "usr-d", membershipId: 4, name: "D", lifecycleStatus: "CONFIRMED", probationEndDate: "2026-09-22" }),
      ],
    });

    const home = await svc.getHome(MANAGER, NOW);

    expect(home.probationDue).toEqual([
      { userId: "usr-b", name: "B", probationEndDate: "2026-09-25", daysLeft: 4 },
      { userId: "usr-a", name: "A", probationEndDate: "2026-10-15", daysLeft: 24 },
    ]);
  });

  it("lists the team but no approvals for a principal with no membership, since nothing can be routed to it", async () => {
    const { svc, calls } = service({ reports: [report()] });
    const agent = { ...MANAGER, principal: agentTokenPrincipal(77, 5, []) } as unknown as CurrentUserContext;

    const home = await svc.getHome(agent, NOW);

    expect(home.isManager).toBe(true);
    expect(home.approvals.items).toEqual([]);
    expect(calls.leave).toEqual([]);
    expect(calls.workflows).toEqual([]);
  });
});

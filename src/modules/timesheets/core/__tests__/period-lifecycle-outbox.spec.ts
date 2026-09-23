import { PgDialect } from "drizzle-orm/pg-core";
import { outboxEvents } from "../../../../db/schema/common/outbox";
import {
  organizationMembers,
  timesheetPeriods,
  timesheetSettings,
  timesheets,
} from "../../../../db/schema";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { logger } from "../../../../common/logger/logger.service";
import { ApprovalsBulkService } from "../approvals-bulk.service";
import { ApprovalsService } from "../approvals.service";
import { PeriodsReadService } from "../periods-read.service";
import { PeriodsSubmitService } from "../periods-submit.service";
import { PeriodsService } from "../periods.service";
import { TIMESHEET_PERIOD_AGGREGATE } from "../events/timesheet-lifecycle.events";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";
import type { EntriesService } from "../entries.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import type { RateResolverService } from "../rate-resolver.service";
import type { TimesheetsAuditService } from "../timesheets-audit.service";
import type { TimesheetApprovalRoutingService } from "../approval-routing.service";
import type { TimesheetRoutingDecision } from "../lib/approval-routing";

jest.mock("../../../../common/organization/organization-actor", () => ({
  ...jest.requireActual("../../../../common/organization/organization-actor"),
  assertOrganizationActor: () =>
    Promise.resolve({ membershipId: 77, userId: "usr-manager" }),
}));

const ORG = "org-1";
const PERIOD_ID = 42;
const WORKER_MEMBERSHIP = 11;
const APPROVER_MEMBERSHIP = 77;

interface Member {
  id: number;
  orgId: string;
  userId: string;
}

const MEMBERS: readonly Member[] = [
  { id: WORKER_MEMBERSHIP, orgId: ORG, userId: "usr-worker" },
  { id: APPROVER_MEMBERSHIP, orgId: ORG, userId: "usr-manager" },
];

const WORKER = {
  userId: "usr-worker",
  orgId: ORG,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s1",
  tokenScopes: null,
  principal: humanSessionPrincipal(WORKER_MEMBERSHIP, false),
} as unknown as CurrentUserContext;

const APPROVER = {
  userId: "usr-manager",
  orgId: ORG,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s2",
  tokenScopes: null,
  principal: humanSessionPrincipal(APPROVER_MEMBERSHIP, false),
} as unknown as CurrentUserContext;

const PERIOD_ROW = {
  id: PERIOD_ID,
  orgId: ORG,
  userMembershipId: WORKER_MEMBERSHIP,
  periodStart: "2026-09-01",
  periodEnd: "2026-09-07",
  status: "OPEN",
  totalHours: "38.50",
  billableHours: "31.00",
  nonBillableHours: "7.50",
  submittedAt: null,
  approvedAt: null,
  rejectedAt: null,
  lockedAt: null,
  currentApproverMembershipId: null as number | null,
  approvedByMembershipId: null,
  rejectionReason: null,
  eventSeq: 0,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  userEmail: "worker@example.test",
  userName: "Asha",
};

const SUBMITTED_ROW = {
  ...PERIOD_ROW,
  status: "SUBMITTED",
  currentApproverMembershipId: APPROVER_MEMBERSHIP,
};

function transitionRow(
  status: string,
  eventSeq: number,
  userMembershipId: number | null = WORKER_MEMBERSHIP,
) {
  return {
    eventSeq,
    userMembershipId,
    periodStart: "2026-09-01",
    periodEnd: "2026-09-07",
    status,
    totalHours: "38.50",
    billableHours: "31.00",
    nonBillableHours: "7.50",
  };
}

interface OutboxRow {
  organizationId: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  occurredAt: Date;
  deliveryState: string;
  payload: Record<string, unknown>;
}

interface Notification {
  eventKey: string;
  targetUserIds: string[];
  entityId: string;
}

interface Script {
  selects: Array<[unknown, unknown[][]]>;
  transitions: unknown[][];
  entries?: unknown[];
  members?: readonly Member[];
}

const dialect = new PgDialect();

function boundValues(where: unknown): unknown[] {
  if (!where) return [];
  return dialect.sqlToQuery(where as Parameters<PgDialect["sqlToQuery"]>[0]).params;
}

function makeDb(script: Script, outbox: OutboxRow[]) {
  const queues = new Map(script.selects.map(([t, q]) => [t, q.slice()]));
  const transitions = script.transitions.slice();
  const members = script.members ?? MEMBERS;
  let periodPatch: Record<string, unknown> = {};
  const periodSets: Record<string, unknown>[] = [];
  let txRan = false;

  const answerMembers = (where: unknown): Member[] => {
    const bound = boundValues(where);
    if (!bound.includes(ORG)) return [];
    return members.filter(
      (m) => m.orgId === ORG && (bound.includes(m.id) || bound.includes(m.userId)),
    );
  };

  const pull = (table: unknown, where: unknown): unknown[] => {
    if (table === organizationMembers) return answerMembers(where);
    const q = queues.get(table);
    const rows = !q || q.length === 0 ? [] : q.length > 1 ? q.shift()! : q[0]!;
    return table === timesheetPeriods
      ? rows.map((r) => ({ ...(r as Record<string, unknown>), ...periodPatch }))
      : rows;
  };

  const selectChain = () => {
    let table: unknown = null;
    let where: unknown;
    const node: Record<string, unknown> = {};
    for (const m of ["leftJoin", "innerJoin", "orderBy", "groupBy", "limit", "offset"]) {
      node[m] = () => node;
    }
    node.from = (t: unknown) => {
      table = t;
      return node;
    };
    node.where = (w: unknown) => {
      where = w;
      return node;
    };
    node.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => pull(table, where))
        .then(ok, err);
    return node;
  };

  const update = (table: unknown) => ({
    set: (values: Record<string, unknown>) => {
      if (table === timesheetPeriods) {
        periodSets.push(values);
        periodPatch = { ...periodPatch, ...values };
      }
      return {
        where: () => {
          const result: Promise<undefined> & {
            returning?: () => Promise<unknown[]>;
          } = Promise.resolve(undefined);
          result.returning = () =>
            Promise.resolve(
              table === timesheetPeriods ? (transitions.shift() ?? []) : [],
            );
          return result;
        },
      };
    },
  });

  const txInsert = (table: unknown) => ({
    values: (row: unknown) => {
      if (table === outboxEvents) outbox.push(row as OutboxRow);
      return Promise.resolve(undefined);
    },
  });

  const tx = {
    select: selectChain,
    update,
    insert: txInsert,
  };

  const db = {
    select: selectChain,
    update,
    insert: () => {
      throw new Error("outbox write escaped the transition transaction");
    },
    transaction: (body: (handle: unknown) => Promise<unknown>) => {
      txRan = true;
      return body(tx);
    },
    query: {
      timesheets: { findMany: () => Promise.resolve(script.entries ?? []) },
    },
  } as unknown as Db;

  return { db, ranTransaction: () => txRan, periodUpdates: () => periodSets };
}

function makeNotifications(sink: Notification[]) {
  return {
    emit: (input: Notification) => {
      sink.push(input);
      return Promise.resolve({ notificationIds: [] });
    },
  } as unknown as NotificationDispatchService;
}

const access = {} as unknown as AccessService;
const audit = { record: () => Promise.resolve() } as unknown as TimesheetsAuditService;
const entriesService = {
  recomputePeriodTotals: () => Promise.resolve(),
} as unknown as EntriesService;
const rateResolver = {
  resolveMany: () => Promise.resolve([]),
} as unknown as RateResolverService;

const ROUTED_TO_MANAGER: TimesheetRoutingDecision = {
  kind: "routed",
  approver: { userId: "usr-manager", membershipId: APPROVER_MEMBERSHIP, name: "Manager", email: "manager@example.test", designation: null },
  queueUserIds: [],
  route: {
    source: "reporting_manager",
    rung: "reporting_manager",
    approverUserId: "usr-manager",
    approverMembershipId: APPROVER_MEMBERSHIP,
    assignedToUserId: "usr-manager",
    delegation: null,
    projectId: 9,
    explanation: "Manager approves as reporting manager.",
    slaHours: 48,
    escalationRung: "queue",
    escalatedFrom: null,
  },
  dueAt: new Date("2026-09-10T00:00:00.000Z"),
};

const UNOWNED: TimesheetRoutingDecision = {
  kind: "unowned",
  explanation: "Nobody can approve this timesheet.",
};

const ROUTED_NO_NOTIFY: TimesheetRoutingDecision = {
  kind: "routed",
  approver: null,
  queueUserIds: [],
  route: {
    source: "reporting_manager",
    rung: null,
    approverUserId: null,
    approverMembershipId: null,
    assignedToUserId: null,
    delegation: null,
    projectId: null,
    explanation: "No approver assigned.",
    slaHours: 48,
    escalationRung: null,
    escalatedFrom: null,
  },
  dueAt: new Date("2026-09-10T00:00:00.000Z"),
};

function makeRouting(decision: TimesheetRoutingDecision) {
  return { resolve: () => Promise.resolve(decision) } as unknown as TimesheetApprovalRoutingService;
}

function periodsService(db: Db, notifications: NotificationDispatchService, decision: TimesheetRoutingDecision = ROUTED_TO_MANAGER) {
  const reader = new PeriodsReadService(db, access);
  const submit = new PeriodsSubmitService(db, reader, entriesService, audit, makeRouting(decision), rateResolver);
  return new PeriodsService(db, reader, submit, audit, notifications);
}

function approvalsService(db: Db, notifications: NotificationDispatchService) {
  return new ApprovalsService(db, access, audit, rateResolver, notifications);
}

function approvalsBulkService(db: Db, notifications: NotificationDispatchService) {
  return new ApprovalsBulkService(db, audit, approvalsService(db, notifications), rateResolver);
}

function submitScript(seq: number): Script {
  return {
    selects: [
      [timesheetPeriods, [[PERIOD_ROW]]],
      [timesheetSettings, [[]]],
    ],
    transitions: [[transitionRow("SUBMITTED", seq)]],
    entries: [{ id: 1, description: "Work", projectId: 9, ticketId: null }],
  };
}

function approveScript(seq: number, lockAfterApproval: boolean): Script {
  return {
    selects: [
      [timesheetPeriods, [[SUBMITTED_ROW]]],
      [timesheetSettings, [[{ lockAfterApproval }]]],
      [timesheets, [[]]],
    ],
    transitions: [[transitionRow("APPROVED", seq)]],
  };
}

function rejectScript(seq: number): Script {
  return {
    selects: [[timesheetPeriods, [[SUBMITTED_ROW]]]],
    transitions: [[transitionRow("REJECTED", seq)]],
  };
}

function lockScript(seq: number, userMembershipId: number | null = WORKER_MEMBERSHIP): Script {
  return {
    selects: [[timesheetPeriods, [[{ ...SUBMITTED_ROW, status: "APPROVED", userMembershipId }]]]],
    transitions: [[transitionRow("LOCKED", seq, userMembershipId)]],
  };
}

describe("TS-24 period lifecycle durable rows", () => {
  describe("submit", () => {
    it("writes one outbox row, inside the transition transaction", async () => {
      const outbox: OutboxRow[] = [];
      const notes: Notification[] = [];
      const { db, ranTransaction } = makeDb(submitScript(1), outbox);
      const service = periodsService(db, makeNotifications(notes));

      await service.submitPeriod(WORKER, PERIOD_ID);

      expect(ranTransaction()).toBe(true);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        organizationId: ORG,
        aggregateType: TIMESHEET_PERIOD_AGGREGATE,
        aggregateId: String(PERIOD_ID),
        aggregateVersion: 1,
        eventType: "timesheets.period.submitted",
        deliveryState: "PENDING",
      });
    });

    it("carries the facts a subscriber needs, with the worker as the subject", async () => {
      const outbox: OutboxRow[] = [];
      const { db } = makeDb(submitScript(1), outbox);
      const service = periodsService(db, makeNotifications([]));

      await service.submitPeriod(WORKER, PERIOD_ID);

      expect(outbox[0]!.payload).toMatchObject({
        organization_id: ORG,
        period_id: PERIOD_ID,
        user_id: "usr-worker",
        status: "SUBMITTED",
        total_hours: "38.50",
        actor_user_id: "usr-worker",
        reason: null,
      });
    });

    it("notifies the resolved approver and nobody else", async () => {
      const notes: Notification[] = [];
      const { db, periodUpdates } = makeDb(submitScript(1), []);
      const service = periodsService(db, makeNotifications(notes));

      await service.submitPeriod(WORKER, PERIOD_ID);

      expect(periodUpdates()[0]).toMatchObject({
        status: "SUBMITTED",
        currentApproverMembershipId: APPROVER_MEMBERSHIP,
        approvalRoute: ROUTED_TO_MANAGER.route,
        approvalDueAt: ROUTED_TO_MANAGER.dueAt,
      });
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        eventKey: "timesheets.period.submitted",
        targetUserIds: ["usr-manager"],
        entityId: String(PERIOD_ID),
      });
    });

    it("still emits the event when there is no approver to notify", async () => {
      const outbox: OutboxRow[] = [];
      const notes: Notification[] = [];
      const script = submitScript(1);
      script.entries = [{ id: 1, description: "Work", projectId: null, ticketId: null }];
      const { db } = makeDb(script, outbox);
      const service = periodsService(db, makeNotifications(notes), ROUTED_NO_NOTIFY);

      await service.submitPeriod(WORKER, PERIOD_ID);

      expect(outbox).toHaveLength(1);
      expect(notes).toHaveLength(0);
    });

    it("resubmits a rejected period, clearing the rejection it is answering", async () => {
      const script = submitScript(3);
      script.selects[0] = [timesheetPeriods, [[{ ...PERIOD_ROW, status: "REJECTED", rejectedAt: new Date("2026-09-08T00:00:00.000Z"), rejectionReason: "Friday is missing" }]]];
      const { db, periodUpdates } = makeDb(script, []);
      const service = periodsService(db, makeNotifications([]));

      await service.submitPeriod(WORKER, PERIOD_ID);

      expect(periodUpdates()[0]).toMatchObject({ status: "SUBMITTED", rejectedAt: null, rejectionReason: null });
    });

    it("refuses the submit, writing no event and no notice, when nobody can own the approval", async () => {
      const outbox: OutboxRow[] = [];
      const notes: Notification[] = [];
      const { db, ranTransaction } = makeDb(submitScript(1), outbox);
      const service = periodsService(db, makeNotifications(notes), UNOWNED);

      await expect(service.submitPeriod(WORKER, PERIOD_ID)).rejects.toThrow("Nobody can approve this timesheet.");

      expect(ranTransaction()).toBe(false);
      expect(outbox).toHaveLength(0);
      expect(notes).toHaveLength(0);
    });
  });

  describe("approve", () => {
    it("writes the approval row and notifies the worker", async () => {
      const outbox: OutboxRow[] = [];
      const notes: Notification[] = [];
      const { db, ranTransaction } = makeDb(approveScript(4, false), outbox);
      const service = approvalsService(db, makeNotifications(notes));

      await service.approvePeriod(APPROVER, PERIOD_ID);

      expect(ranTransaction()).toBe(true);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        aggregateVersion: 4,
        eventType: "timesheets.period.approved",
        aggregateId: String(PERIOD_ID),
      });
      expect(outbox[0]!.payload).toMatchObject({
        status: "APPROVED",
        actor_user_id: "usr-manager",
        user_id: "usr-worker",
      });
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        eventKey: "timesheets.period.approved",
        targetUserIds: ["usr-worker"],
      });
    });

    it("emits approved and locked as two rows with two versions from one now", async () => {
      const outbox: OutboxRow[] = [];
      const { db } = makeDb(approveScript(5, true), outbox);
      const service = approvalsService(db, makeNotifications([]));

      await service.approvePeriod(APPROVER, PERIOD_ID);

      expect(outbox.map((r) => r.eventType)).toEqual([
        "timesheets.period.approved",
        "timesheets.period.locked",
      ]);
      expect(outbox.map((r) => r.aggregateVersion)).toEqual([4, 5]);
      expect(outbox[0]!.occurredAt).toEqual(outbox[1]!.occurredAt);
      expect(new Set(outbox.map((r) => r.aggregateVersion)).size).toBe(2);
    });

    it("emits only the approval when the organisation does not lock on approve", async () => {
      const outbox: OutboxRow[] = [];
      const { db } = makeDb(approveScript(4, false), outbox);
      const service = approvalsService(db, makeNotifications([]));

      await service.approvePeriod(APPROVER, PERIOD_ID);

      expect(outbox.map((r) => r.eventType)).toEqual(["timesheets.period.approved"]);
    });
  });

  describe("lock", () => {
    it("writes the locked row, with the worker as the subject", async () => {
      const outbox: OutboxRow[] = [];
      const { db, ranTransaction } = makeDb(lockScript(6), outbox);

      await periodsService(db, makeNotifications([])).lockPeriod(APPROVER, PERIOD_ID);

      expect(ranTransaction()).toBe(true);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        eventType: "timesheets.period.locked",
        aggregateVersion: 6,
      });
      expect(outbox[0]!.payload).toMatchObject({
        user_id: "usr-worker",
        actor_user_id: "usr-manager",
      });
    });
  });

  it("keeps every version distinct across a submit / reject / resubmit / approve+lock life", async () => {
    const outbox: OutboxRow[] = [];
    const notifications = makeNotifications([]);

    const periods = (script: Script) =>
      periodsService(makeDb(script, outbox).db, notifications);
    const approvals = (script: Script) =>
      approvalsService(makeDb(script, outbox).db, notifications);
    const bulk = (script: Script) =>
      approvalsBulkService(makeDb(script, outbox).db, notifications);

    await periods(submitScript(1)).submitPeriod(WORKER, PERIOD_ID);
    await bulk(rejectScript(2)).rejectPeriod(APPROVER, PERIOD_ID, {
      reason: "Friday is missing",
    });
    await periods(submitScript(3)).submitPeriod(WORKER, PERIOD_ID);
    await approvals(approveScript(5, true)).approvePeriod(APPROVER, PERIOD_ID);

    expect(outbox.map((r) => r.eventType)).toEqual([
      "timesheets.period.submitted",
      "timesheets.period.rejected",
      "timesheets.period.submitted",
      "timesheets.period.approved",
      "timesheets.period.locked",
    ]);

    const uniqueKeys = new Set(
      outbox.map(
        (r) =>
          `${r.organizationId}|${r.aggregateType}|${r.aggregateId}|${r.aggregateVersion}`,
      ),
    );
    expect(uniqueKeys.size).toBe(outbox.length);
    expect(outbox.map((r) => r.aggregateVersion)).toEqual([1, 2, 3, 4, 5]);
  });

  it("carries the rejection reason into both the event and the notification", async () => {
    const outbox: OutboxRow[] = [];
    const notes: Notification[] = [];
    const { db } = makeDb(rejectScript(2), outbox);
    const service = approvalsBulkService(db, makeNotifications(notes));

    await service.rejectPeriod(APPROVER, PERIOD_ID, { reason: "Friday is missing" });

    expect(outbox[0]).toMatchObject({
      eventType: "timesheets.period.rejected",
      aggregateVersion: 2,
    });
    expect(outbox[0]!.payload).toMatchObject({ reason: "Friday is missing" });
    expect(notes[0]).toMatchObject({
      eventKey: "timesheets.period.rejected",
      targetUserIds: ["usr-worker"],
    });
  });

  describe("when the worker's membership no longer resolves", () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    const withoutWorker = MEMBERS.filter((m) => m.id !== WORKER_MEMBERSHIP);

    it("still approves, and announces nothing", async () => {
      const outbox: OutboxRow[] = [];
      const notes: Notification[] = [];
      const { db, ranTransaction, periodUpdates } = makeDb(
        { ...approveScript(5, true), members: withoutWorker },
        outbox,
      );

      await approvalsService(db, makeNotifications(notes)).approvePeriod(APPROVER, PERIOD_ID);

      expect(ranTransaction()).toBe(true);
      expect(periodUpdates()[0]).toMatchObject({ status: "APPROVED" });
      expect(outbox).toEqual([]);
      expect(notes).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("skipped"),
        expect.objectContaining({ orgId: ORG, periodId: PERIOD_ID, operation: "approve" }),
      );
    });

    it("still rejects, and announces nothing", async () => {
      const outbox: OutboxRow[] = [];
      const notes: Notification[] = [];
      const { db, ranTransaction, periodUpdates } = makeDb(
        { ...rejectScript(2), members: withoutWorker },
        outbox,
      );

      await approvalsBulkService(db, makeNotifications(notes)).rejectPeriod(APPROVER, PERIOD_ID, {
        reason: "Friday is missing",
      });

      expect(ranTransaction()).toBe(true);
      expect(periodUpdates()[0]).toMatchObject({ status: "REJECTED" });
      expect(outbox).toEqual([]);
      expect(notes).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("skipped"),
        expect.objectContaining({ periodId: PERIOD_ID, operation: "reject" }),
      );
    });

    it("still locks a removed worker's period, without the locked event", async () => {
      const outbox: OutboxRow[] = [];
      const { db, ranTransaction, periodUpdates } = makeDb(lockScript(6, null), outbox);

      await periodsService(db, makeNotifications([])).lockPeriod(APPROVER, PERIOD_ID);

      expect(ranTransaction()).toBe(true);
      expect(periodUpdates()[0]).toMatchObject({ status: "LOCKED", lockedAt: expect.any(Date) });
      expect(outbox).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("skipped"),
        expect.objectContaining({ periodId: PERIOD_ID, ownerMembershipId: null, operation: "lock" }),
      );
    });
  });
});

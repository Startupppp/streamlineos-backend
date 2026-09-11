import { outboxEvents } from "../../../../db/schema/common/outbox";
import {
  projects,
  timesheetPeriods,
  timesheetSettings,
  timesheets,
} from "../../../../db/schema";
import { ApprovalsService } from "../approvals.service";
import { PeriodsService } from "../periods.service";
import { TIMESHEET_PERIOD_AGGREGATE } from "../events/timesheet-lifecycle.events";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";
import type { EntriesService } from "../entries.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import type { RateResolverService } from "../rate-resolver.service";
import type { TimesheetsAuditService } from "../timesheets-audit.service";

/**
 * `assertOrganizationActor` reads the actor's membership out of the database on
 * every approval. Mocked, because this file is about what the transition
 * *writes*, and the actor lookup is `organization-actor`'s own subject.
 */
jest.mock("../../../../common/organization/organization-actor", () => ({
  ...jest.requireActual("../../../../common/organization/organization-actor"),
  assertOrganizationActor: () =>
    Promise.resolve({ membershipId: "mem-approver", userId: "usr-manager" }),
}));

/**
 * TS-24. The durable rows a period lifecycle transition leaves behind.
 *
 * Both halves of the wiring existed and neither was asserted anywhere. The
 * consumer side has had a spec since TS-06 — but a consumer registered for an
 * event nobody emits is a test that passes over a feature that does nothing,
 * and that is exactly the shape of failure this file exists to rule out.
 *
 * Two rows per transition, and they are not the same mechanism:
 *
 *   - **`outbox_events`**, written by `OutboxWriter.emit` on the transition's
 *     own `tx`, for external subscribers. Durable and replayable: it commits
 *     with the status change or not at all.
 *   - **the notification**, emitted through `NotificationDispatchService` after
 *     the transaction, which is what the ticket means by "the existing email
 *     outbox" — no second mailer.
 *
 * **The version, which is the part that is easy to get wrong.**
 * `outbox_events` is UNIQUE on
 * `(organization_id, aggregate_type, aggregate_id, aggregate_version)`, and
 * `aggregate_version` is `timesheet_periods.event_seq` — a counter incremented
 * by the same UPDATE that performs the transition. A period emits repeatedly:
 * submitted, rejected, submitted again, approved, locked, reopened, all over
 * again. So a constant version works exactly once per period and then fails
 * forever, and a wall-clock version collides on approve-with-lock, which emits
 * **two** events from one transaction sharing one `now`. Both of those are
 * asserted below, on the counter rather than on the mere presence of a row.
 *
 * `db.transaction` here runs its callback against a recording handle. A bare
 * `jest.fn()` would void every assertion in this file while reporting green, so
 * each case also asserts the callback actually ran, and `db.insert` outside the
 * transaction throws — the emit must be inside it or the test fails loudly
 * rather than silently passing on a row written after the commit.
 */

const ORG = "org-1";
const PERIOD_ID = 42;

const WORKER = {
  userId: "usr-worker",
  orgId: ORG,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s1",
  tokenScopes: null,
} as unknown as CurrentUserContext;

const APPROVER = {
  userId: "usr-manager",
  orgId: ORG,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s2",
  tokenScopes: null,
} as unknown as CurrentUserContext;

const PERIOD_ROW = {
  id: PERIOD_ID,
  orgId: ORG,
  userId: "usr-worker",
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
  currentApproverId: "usr-manager",
  approvedBy: null,
  rejectionReason: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  userEmail: "worker@example.test",
  userName: "Asha",
};

/** What the transition's own UPDATE hands back, `event_seq` included. */
function transitionRow(status: string, eventSeq: number) {
  return {
    eventSeq,
    userId: "usr-worker",
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
  /** Per-table select results, consumed in order; the last one repeats. */
  selects: Array<[unknown, unknown[][]]>;
  /** Rows `.returning()` hands back from the in-transaction period UPDATE. */
  transitions: unknown[][];
  /** Entries returned by `db.query.timesheets.findMany`. */
  entries?: unknown[];
}

function makeDb(script: Script, outbox: OutboxRow[]) {
  const queues = new Map(script.selects.map(([t, q]) => [t, q.slice()]));
  const transitions = script.transitions.slice();
  let txRan = false;

  const pull = (table: unknown): unknown[] => {
    const q = queues.get(table);
    if (!q || q.length === 0) return [];
    return q.length > 1 ? q.shift()! : q[0]!;
  };

  const selectChain = () => {
    let table: unknown = null;
    const node: Record<string, unknown> = {};
    for (const m of ["leftJoin", "innerJoin", "where", "orderBy", "groupBy", "limit", "offset"]) {
      node[m] = () => node;
    }
    node.from = (t: unknown) => {
      table = t;
      return node;
    };
    node.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
      Promise.resolve(pull(table)).then(ok, err);
    return node;
  };

  const update = (table: unknown) => ({
    set: () => ({
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
    }),
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
    /**
     * Nothing may write outside the transaction. An emit moved after the commit
     * would still produce a row and would still look correct in a test that only
     * counted rows.
     */
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

  return { db, ranTransaction: () => txRan };
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

/** A submit whose entries carry a project, so an approver is resolved. */
function submitScript(seq: number): Script {
  return {
    selects: [
      [timesheetPeriods, [[PERIOD_ROW], [{ ...PERIOD_ROW, status: "SUBMITTED" }]]],
      [timesheetSettings, [[]]],
      [projects, [[{ managerId: "usr-manager" }]]],
    ],
    transitions: [[transitionRow("SUBMITTED", seq)]],
    entries: [{ id: 1, description: "Work", projectId: 9, ticketId: null }],
  };
}

function approveScript(seq: number, lockAfterApproval: boolean): Script {
  return {
    selects: [
      [
        timesheetPeriods,
        [
          [{ ...PERIOD_ROW, status: "SUBMITTED" }],
          [{ ...PERIOD_ROW, status: "APPROVED" }],
        ],
      ],
      [timesheetSettings, [[{ lockAfterApproval }]]],
      [timesheets, [[]]],
    ],
    transitions: [[transitionRow("APPROVED", seq)]],
  };
}

function rejectScript(seq: number): Script {
  return {
    selects: [
      [
        timesheetPeriods,
        [
          [{ ...PERIOD_ROW, status: "SUBMITTED" }],
          [{ ...PERIOD_ROW, status: "REJECTED" }],
        ],
      ],
      [timesheetSettings, [[]]],
    ],
    transitions: [[transitionRow("REJECTED", seq)]],
  };
}

describe("TS-24 period lifecycle durable rows", () => {
  describe("submit", () => {
    it("writes one outbox row, inside the transition transaction", async () => {
      const outbox: OutboxRow[] = [];
      const notes: Notification[] = [];
      const { db, ranTransaction } = makeDb(submitScript(1), outbox);
      const service = new PeriodsService(
        db,
        access,
        entriesService,
        audit,
        makeNotifications(notes),
      );

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
      const service = new PeriodsService(
        db,
        access,
        entriesService,
        audit,
        makeNotifications([]),
      );

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

    /** The other durable row: the approver is told, through the existing pipeline. */
    it("notifies the resolved approver and nobody else", async () => {
      const notes: Notification[] = [];
      const { db } = makeDb(submitScript(1), []);
      const service = new PeriodsService(
        db,
        access,
        entriesService,
        audit,
        makeNotifications(notes),
      );

      await service.submitPeriod(WORKER, PERIOD_ID);

      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        eventKey: "timesheets.period.submitted",
        targetUserIds: ["usr-manager"],
        entityId: String(PERIOD_ID),
      });
    });

    /**
     * A period with no project work resolves no approver, and there is no
     * honest fallback — broadcasting an unrouted timesheet to every manager is
     * worse than the approvals queue being the only place it appears. The
     * event still goes out: an external subscriber's routing is its own.
     */
    it("still emits the event when there is no approver to notify", async () => {
      const outbox: OutboxRow[] = [];
      const notes: Notification[] = [];
      const script = submitScript(1);
      script.entries = [{ id: 1, description: "Work", projectId: null, ticketId: null }];
      const { db } = makeDb(script, outbox);
      const service = new PeriodsService(
        db,
        access,
        entriesService,
        audit,
        makeNotifications(notes),
      );

      await service.submitPeriod(WORKER, PERIOD_ID);

      expect(outbox).toHaveLength(1);
      expect(notes).toHaveLength(0);
    });
  });

  describe("approve", () => {
    it("writes the approval row and notifies the worker", async () => {
      const outbox: OutboxRow[] = [];
      const notes: Notification[] = [];
      const { db, ranTransaction } = makeDb(approveScript(4, false), outbox);
      const service = new ApprovalsService(
        db,
        access,
        audit,
        rateResolver,
        makeNotifications(notes),
      );

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

    /**
     * The collision the boundary doc names. One transaction, one `now`, two
     * events — so the version cannot be a timestamp, and it cannot be a single
     * `event_seq` reused for both. The UPDATE claims `+2` at once and the emits
     * take `seq - 1` and `seq`, which is what makes the pair survive a UNIQUE
     * index that a wall clock would have violated.
     */
    it("emits approved and locked as two rows with two versions from one now", async () => {
      const outbox: OutboxRow[] = [];
      const { db } = makeDb(approveScript(5, true), outbox);
      const service = new ApprovalsService(
        db,
        access,
        audit,
        rateResolver,
        makeNotifications([]),
      );

      await service.approvePeriod(APPROVER, PERIOD_ID);

      expect(outbox.map((r) => r.eventType)).toEqual([
        "timesheets.period.approved",
        "timesheets.period.locked",
      ]);
      expect(outbox.map((r) => r.aggregateVersion)).toEqual([4, 5]);
      /** The two share a wall clock, which is precisely why it cannot be the version. */
      expect(outbox[0]!.occurredAt).toEqual(outbox[1]!.occurredAt);
      expect(new Set(outbox.map((r) => r.aggregateVersion)).size).toBe(2);
    });

    /** With the org's lock-after-approval off, one transition is one event. */
    it("emits only the approval when the organisation does not lock on approve", async () => {
      const outbox: OutboxRow[] = [];
      const { db } = makeDb(approveScript(4, false), outbox);
      const service = new ApprovalsService(
        db,
        access,
        audit,
        rateResolver,
        makeNotifications([]),
      );

      await service.approvePeriod(APPROVER, PERIOD_ID);

      expect(outbox.map((r) => r.eventType)).toEqual(["timesheets.period.approved"]);
    });
  });

  /**
   * The property the UNIQUE index actually tests, which no single transition
   * can show: a period is not a one-shot aggregate. Submitted, rejected,
   * submitted again, approved and locked is an ordinary week, and it emits five
   * times against one `(organization_id, aggregate_type, aggregate_id)`.
   *
   * A constant version passes every test above and fails the second row here.
   */
  it("keeps every version distinct across a submit / reject / resubmit / approve+lock life", async () => {
    const outbox: OutboxRow[] = [];
    const notifications = makeNotifications([]);

    const periods = (script: Script) =>
      new PeriodsService(
        makeDb(script, outbox).db,
        access,
        entriesService,
        audit,
        notifications,
      );
    const approvals = (script: Script) =>
      new ApprovalsService(
        makeDb(script, outbox).db,
        access,
        audit,
        rateResolver,
        notifications,
      );

    await periods(submitScript(1)).submitPeriod(WORKER, PERIOD_ID);
    await approvals(rejectScript(2)).rejectPeriod(APPROVER, PERIOD_ID, {
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

  /**
   * And the rejection's own two rows, because a rejection is the transition a
   * worker most needs to hear about and the one a subscriber most needs the
   * reason for.
   */
  it("carries the rejection reason into both the event and the notification", async () => {
    const outbox: OutboxRow[] = [];
    const notes: Notification[] = [];
    const { db } = makeDb(rejectScript(2), outbox);
    const service = new ApprovalsService(
      db,
      access,
      audit,
      rateResolver,
      makeNotifications(notes),
    );

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
});

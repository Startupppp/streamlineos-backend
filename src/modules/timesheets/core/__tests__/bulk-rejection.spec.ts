import { ForbiddenException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { outboxEvents } from "../../../../db/schema/common/outbox";
import { organizationMembers, timesheetPeriods, timesheets } from "../../../../db/schema";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { logger } from "../../../../common/logger/logger.service";
import { ApprovalsBulkService } from "../approvals-bulk.service";
import type { ApprovalsService } from "../approvals.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";
import type { TimesheetsAuditService } from "../timesheets-audit.service";
import type { RateResolverService } from "../rate-resolver.service";

/**
 * `ApprovalsBulkService.bulkReject`, and the batch writes in
 * `lib/rejection-transition.ts` it runs inside one transaction.
 *
 * Nothing asserted this path before: making `applyBulkRejection` throw left
 * every timesheets suite green. The single-period rejection is covered by
 * `period-lifecycle-outbox.spec.ts`; this file is the batch. What it pins:
 * only periods past the approver's guard are written, every write is tenant
 * scoped and on the transaction, each period gets its own audit row, event
 * and notice, and a worker whose membership no longer resolves is rejected
 * without being announced.
 *
 * The real service and the real transition over a fake database. `db.update`
 * and `db.insert` outside the transaction throw, so a write that escaped it
 * fails loudly instead of passing on a row written after the commit.
 */

const ORG = "org-1";
const APPROVER_MEMBERSHIP = 77;
const REASON = "Thursday's hours are missing";

interface Member {
  id: number;
  orgId: string;
  userId: string;
}

const MEMBERS: readonly Member[] = [
  { id: 11, orgId: ORG, userId: "usr-asha" },
  { id: 12, orgId: ORG, userId: "usr-ben" },
  { id: 13, orgId: ORG, userId: "usr-chen" },
  { id: APPROVER_MEMBERSHIP, orgId: ORG, userId: "usr-manager" },
];

const APPROVER = {
  userId: "usr-manager",
  orgId: ORG,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s2",
  tokenScopes: null,
  principal: humanSessionPrincipal(APPROVER_MEMBERSHIP, false),
} as unknown as CurrentUserContext;

/** Three submitted periods, one worker each, all routed to the approver. */
const CANDIDATES = [
  { id: 41, status: "SUBMITTED", userMembershipId: 11, currentApproverMembershipId: 77 },
  { id: 42, status: "SUBMITTED", userMembershipId: 12, currentApproverMembershipId: 77 },
  { id: 43, status: "SUBMITTED", userMembershipId: 13, currentApproverMembershipId: 77 },
];

/** What the batch UPDATE hands back for one period, `event_seq` already bumped. */
function transitionRow(id: number, eventSeq: number, userMembershipId: number) {
  return {
    id,
    eventSeq,
    userMembershipId,
    periodStart: "2026-09-01",
    periodEnd: "2026-09-07",
    status: "REJECTED",
    totalHours: "38.50",
    billableHours: "31.00",
    nonBillableHours: "7.50",
  };
}

const dialect = new PgDialect();
const query = (where: unknown) =>
  dialect.sqlToQuery(where as Parameters<PgDialect["sqlToQuery"]>[0]);

interface Options {
  /** Periods the guard refuses with a ForbiddenException. */
  forbid?: number[];
  /** Periods whose guard fails some other way. */
  guardErrors?: Map<number, Error>;
  members?: readonly Member[];
  transitions?: ReturnType<typeof transitionRow>[];
}

function harness(options: Options = {}) {
  const members = options.members ?? MEMBERS;
  const updates: Array<{ table: unknown; set: Record<string, unknown>; where: unknown }> = [];
  const audits: Array<{ handle: unknown; row: Record<string, unknown> }> = [];
  const outbox: Array<Record<string, unknown>> = [];
  const notices: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  let candidateWhere: unknown;

  const answer = (table: unknown, where: unknown): unknown[] => {
    if (table === timesheetPeriods) {
      candidateWhere = where;
      return CANDIDATES;
    }
    if (table === organizationMembers) {
      // A member lookup that does not bind this organisation answers nothing.
      const bound = query(where).params;
      if (!bound.includes(ORG)) return [];
      return members.filter((m) => m.orgId === ORG && bound.includes(m.id));
    }
    return [];
  };

  const select = () => {
    let table: unknown;
    let where: unknown;
    const node: Record<string, unknown> = {
      from: (t: unknown) => ((table = t), node),
      where: (w: unknown) => ((where = w), node),
      limit: () => node,
      then: (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => answer(table, where))
          .then(ok, err),
    };
    return node;
  };

  const tx = {
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => {
          updates.push({ table, set, where });
          const result: Promise<undefined> & { returning?: () => Promise<unknown[]> } =
            Promise.resolve(undefined);
          result.returning = () =>
            Promise.resolve(table === timesheetPeriods ? (options.transitions ?? []) : []);
          return result;
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        if (table === outboxEvents) outbox.push(row);
        return Promise.resolve(undefined);
      },
    }),
  };

  const escaped = () => {
    throw new Error("a rejection write escaped the transaction");
  };
  const db = {
    select,
    update: escaped,
    insert: escaped,
    transaction: async (body: (handle: unknown) => Promise<unknown>) => {
      order.push("tx:open");
      const out = await body(tx);
      order.push("tx:commit");
      return out;
    },
  } as unknown as Db;

  const audit = {
    record: (handle: unknown, row: Record<string, unknown>) => {
      audits.push({ handle, row });
      return Promise.resolve();
    },
    /** The batch writes its audit rows as one chained INSERT; each row is still recorded. */
    recordMany: (handle: unknown, rows: readonly Record<string, unknown>[]) => {
      for (const row of rows) audits.push({ handle, row });
      return Promise.resolve();
    },
  } as unknown as TimesheetsAuditService;

  const approvals = {
    /** The batch resolves the approver's delegations in one read; nobody here delegates. */
    activeDelegationsToActor: () => Promise.resolve(new Set<number>()),
    assertCanActOnPeriod: (_u: unknown, period: { id: number }) => {
      if (options.forbid?.includes(period.id))
        return Promise.reject(new ForbiddenException("Not your approval"));
      const error = options.guardErrors?.get(period.id);
      return error ? Promise.reject(error) : Promise.resolve();
    },
    notifyPeriodRejected: (_u: unknown, notice: Record<string, unknown>) => {
      order.push(`notify:${String(notice.periodId)}`);
      notices.push(notice);
      return Promise.resolve();
    },
  } as unknown as ApprovalsService;

  const rateResolver = { resolveMany: () => Promise.resolve([]) } as unknown as RateResolverService;
  const service = new ApprovalsBulkService(db, audit, approvals, rateResolver);
  return { service, tx, updates, audits, outbox, notices, order, candidateWhere: () => candidateWhere };
}

const TWO_OF_THREE = [transitionRow(41, 3, 11), transitionRow(42, 7, 12)];

describe("bulk rejection", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("reads only this organisation's submitted periods among the ones asked for", async () => {
    const h = harness({ transitions: TWO_OF_THREE, forbid: [43] });
    await h.service.bulkReject(APPROVER, { periodIds: [41, 42, 43], reason: REASON });

    expect(query(h.candidateWhere()).params).toEqual(
      expect.arrayContaining([ORG, 41, 42, 43, "SUBMITTED"]),
    );
  });

  it("writes only the periods the approver may act on", async () => {
    const h = harness({ transitions: TWO_OF_THREE, forbid: [43] });
    const result = await h.service.bulkReject(APPROVER, { periodIds: [41, 42, 43], reason: REASON });

    expect(result).toEqual({ rejected: 2 });
    const [periods, entries] = h.updates;
    expect(h.updates).toHaveLength(2);
    expect(periods!.table).toBe(timesheetPeriods);
    expect(entries!.table).toBe(timesheets);
    for (const update of h.updates) {
      const bound = query(update.where).params;
      expect(bound).toEqual(expect.arrayContaining([ORG, 41, 42]));
      expect(bound).not.toContain(43);
    }
    expect(h.audits.map((a) => a.row.entityId)).toEqual(["41", "42"]);
    // A plain refusal is the expected case, not something to log.
    expect(warn).not.toHaveBeenCalled();
  });

  it("moves the periods and their live entries to REJECTED with the reason, in one transaction", async () => {
    const h = harness({ transitions: TWO_OF_THREE, forbid: [43] });
    await h.service.bulkReject(APPROVER, { periodIds: [41, 42, 43], reason: REASON });

    const [periods, entries] = h.updates;
    expect(periods!.set).toMatchObject({
      status: "REJECTED",
      rejectionReason: REASON,
      rejectedAt: expect.any(Date),
    });
    expect(periods!.set.eventSeq).toBeDefined();
    expect(entries!.set).toMatchObject({ status: "REJECTED", rejectionReason: REASON });
    expect(query(entries!.where).sql).toContain('"voided_at" is null');
    expect(h.order.filter((step) => step.startsWith("tx:"))).toEqual(["tx:open", "tx:commit"]);
  });

  it("audits each period once, as the approver's membership, on the transaction", async () => {
    const h = harness({ transitions: TWO_OF_THREE, forbid: [43] });
    await h.service.bulkReject(APPROVER, { periodIds: [41, 42, 43], reason: REASON });

    expect(h.audits).toHaveLength(2);
    for (const { handle, row } of h.audits) {
      expect(handle).toBe(h.tx);
      expect(row).toMatchObject({
        orgId: ORG,
        actorMembershipId: APPROVER_MEMBERSHIP,
        entityType: "period",
        action: "period.rejected",
        reason: REASON,
      });
    }
  });

  it("emits one rejected event per period, each on that period's own version", async () => {
    const h = harness({ transitions: TWO_OF_THREE, forbid: [43] });
    await h.service.bulkReject(APPROVER, { periodIds: [41, 42, 43], reason: REASON });

    expect(h.outbox.map((r) => [r.aggregateId, r.aggregateVersion, r.eventType])).toEqual([
      ["41", 3, "timesheets.period.rejected"],
      ["42", 7, "timesheets.period.rejected"],
    ]);
    expect(h.outbox.map((r) => r.organizationId)).toEqual([ORG, ORG]);
    expect(h.outbox.map((r) => (r.payload as Record<string, unknown>).user_id)).toEqual([
      "usr-asha",
      "usr-ben",
    ]);
    for (const row of h.outbox) {
      expect(row.payload).toMatchObject({ reason: REASON, actor_user_id: "usr-manager" });
    }
  });

  it("tells each worker once, after the batch commits", async () => {
    const h = harness({ transitions: TWO_OF_THREE, forbid: [43] });
    await h.service.bulkReject(APPROVER, { periodIds: [41, 42, 43], reason: REASON });

    expect(h.notices.map((n) => [n.periodId, n.ownerUserId])).toEqual([
      [41, "usr-asha"],
      [42, "usr-ben"],
    ]);
    expect(h.notices[0]!.message).toContain(REASON);
    expect(h.order.indexOf("tx:commit")).toBeLessThan(h.order.indexOf("notify:41"));
  });

  it("rejects a worker whose membership no longer resolves, and announces nothing about them", async () => {
    const h = harness({
      transitions: TWO_OF_THREE,
      forbid: [43],
      members: MEMBERS.filter((m) => m.id !== 12),
    });
    const result = await h.service.bulkReject(APPROVER, { periodIds: [41, 42, 43], reason: REASON });

    expect(result).toEqual({ rejected: 2 });
    expect(h.audits.map((a) => a.row.entityId)).toEqual(["41", "42"]);
    expect(h.outbox.map((r) => r.aggregateId)).toEqual(["41"]);
    expect(h.notices.map((n) => n.periodId)).toEqual([41]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("skipped"),
      expect.objectContaining({ orgId: ORG, periodId: 42, operation: "bulk-reject" }),
    );
  });

  it("opens no transaction when the approver may act on none of them", async () => {
    const h = harness({ forbid: [41, 42, 43] });
    const result = await h.service.bulkReject(APPROVER, { periodIds: [41, 42, 43], reason: REASON });

    expect(result).toEqual({ rejected: 0 });
    expect(h.order).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("skips a period whose guard fails unexpectedly, and logs it rather than failing the batch", async () => {
    const h = harness({
      transitions: [transitionRow(41, 3, 11), transitionRow(43, 4, 13)],
      guardErrors: new Map([[42, new Error("approver chain unreadable")]]),
    });
    const result = await h.service.bulkReject(APPROVER, { periodIds: [41, 42, 43], reason: REASON });

    expect(result).toEqual({ rejected: 2 });
    expect(query(h.updates[0]!.where).params).not.toContain(42);
    expect(warn).toHaveBeenCalledWith(
      "bulkReject: assertCanActOnPeriod failed unexpectedly",
      expect.objectContaining({ orgId: ORG, periodId: 42, error: "approver chain unreadable" }),
    );
  });
});

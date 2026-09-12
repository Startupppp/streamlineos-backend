import { ConflictException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { timesheetPeriods, timesheets } from "../../../../db/schema";
import { applyApproval, applyBulkApproval } from "../lib/approval-transition";
import { applyBulkRejection, applyRejection } from "../lib/rejection-transition";

/**
 * The service checks `status = 'SUBMITTED'` before it opens the transaction,
 * unlocked. Two approvers deciding the same period, or an approve racing a
 * reject, both passed that check and both wrote: the second UPDATE flipped a
 * REJECTED period to APPROVED (or back), claimed a second event_seq and wrote
 * a second audit row. The UPDATE now carries the predicate itself, and what it
 * returns is what happened.
 */
const ORG = "org-race";
const U: CurrentUserContext = {
  userId: "approver",
  orgId: ORG,
  role: "MEMBER",
  isOrgOwner: true,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(9, true),
};

const row = (id: number) => ({
  id,
  eventSeq: 4,
  userMembershipId: 12,
  periodStart: "2026-09-01",
  periodEnd: "2026-09-07",
  status: "APPROVED",
  totalHours: "8",
  billableHours: "8",
  nonBillableHours: "0",
});

function harness(stillSubmitted: number[]) {
  const updates: Array<{ table: unknown; where: SQL }> = [];
  const audits: unknown[] = [];
  const tx = {
    update: (table: unknown) => ({
      set: () => ({
        where: (where: SQL) => {
          updates.push({ table, where });
          const bound = new PgDialect().sqlToQuery(where).params;
          const rows = table === timesheetPeriods ? stillSubmitted.filter((id) => bound.includes(id)).map(row) : [];
          return Object.assign(Promise.resolve(undefined), { returning: () => Promise.resolve(rows) });
        },
      }),
    }),
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({ values: () => Promise.resolve(undefined) }),
  };
  const audit = {
    record: (_tx: unknown, r: unknown) => { audits.push(r); return Promise.resolve(); },
    recordMany: (_tx: unknown, rs: readonly unknown[]) => { audits.push(...rs); return Promise.resolve(); },
  };
  const rateResolver = { resolveMany: jest.fn().mockResolvedValue([]) };
  return { tx, audit, rateResolver, updates, audits };
}

const sqlOf = (where: SQL) => new PgDialect().sqlToQuery(where).sql;

describe("a decision is written only while the period is still SUBMITTED", () => {
  it("the single approval predicates on the status and refuses when another decision won", async () => {
    const h = harness([]);
    await expect(
      applyApproval(h.tx as never, { rateResolver: h.rateResolver as never, audit: h.audit as never }, U, 10, {
        approverActor: { membershipId: 9 },
        lockAfterApproval: true,
        emitCount: 2,
        ownerUserId: "worker",
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]!.table).toBe(timesheetPeriods);
    expect(sqlOf(h.updates[0]!.where)).toContain('"status" = ');
    expect(h.audits).toHaveLength(0);
  });

  it("the single rejection does the same", async () => {
    const h = harness([]);
    await expect(
      applyRejection(h.tx as never, { audit: h.audit as never }, U, 10, {
        input: { reason: "late" },
        ownerUserId: "worker",
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.updates.filter((u) => u.table === timesheets)).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("bulk approval returns the ids it actually flipped and writes nothing for the rest", async () => {
    const h = harness([41, 43]);
    const flipped = await applyBulkApproval(
      h.tx as never,
      { rateResolver: h.rateResolver as never, audit: h.audit as never },
      U,
      [41, 42, 43],
      { approverActor: { membershipId: 9 }, lockAfterApproval: false, owners: new Map([[12, "worker"]]), now: new Date() },
    );
    expect(flipped).toEqual([41, 43]);
    const entries = h.updates.find((u) => u.table === timesheets);
    const bound = new PgDialect().sqlToQuery(entries!.where).params;
    expect(bound).toEqual(expect.arrayContaining([41, 43]));
    expect(bound).not.toContain(42);
    expect(h.audits).toHaveLength(2);
  });

  it("bulk rejection returns the ids it actually flipped", async () => {
    const h = harness([42]);
    const flipped = await applyBulkRejection(h.tx as never, { audit: h.audit as never }, U, [41, 42], {
      input: { reason: "late" },
      owners: new Map([[12, "worker"]]),
      now: new Date(),
    });
    expect(flipped).toEqual([42]);
    expect(h.audits).toHaveLength(1);
  });

  it("an empty batch after the race touches no entries and no audit rows", async () => {
    const h = harness([]);
    const flipped = await applyBulkRejection(h.tx as never, { audit: h.audit as never }, U, [41], {
      input: { reason: "late" },
      owners: new Map(),
      now: new Date(),
    });
    expect(flipped).toEqual([]);
    expect(h.updates).toHaveLength(1);
    expect(h.audits).toHaveLength(0);
  });
});

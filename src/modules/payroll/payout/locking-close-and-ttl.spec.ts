import { ConflictException, NotFoundException } from "@nestjs/common";
import { LockingService } from "./locking.service";
import { PayrollRunLockService } from "../run-lock.service";
import type { Db } from "../../../db/drizzle.module";

const ORG_ID = "org-locking";
const OTHER_ORG = "org-other";
const USER_ID = "u-actor";
const RUN_ID = 55;
const MEMBERSHIP_ID = "m-actor";
const LOCK_TTL_MS = 15 * 60 * 1000;

/**
 * Walks a Drizzle predicate for the bound parameter values it carries, so a
 * staleness cutoff can be asserted instead of assumed. Cycles are unavoidable
 * in table metadata, hence the visited set.
 */
function boundValues(node: unknown, seen = new WeakSet<object>(), out: unknown[] = []) {
  if (node === null || typeof node !== "object") {
    if (typeof node === "string" || typeof node === "number") out.push(node);
    return out;
  }
  if (node instanceof Date) {
    out.push(node);
    return out;
  }
  if (seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const child of node) boundValues(child, seen, out);
    return out;
  }
  for (const child of Object.values(node)) boundValues(child, seen, out);
  return out;
}

function staleCutoffFrom(predicate: unknown): Date | null {
  for (const value of boundValues(predicate)) {
    if (value instanceof Date) return value;
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value);
  }
  return null;
}

function makeLockDb(options: {
  returning?: { id: number; generationLockToken: string | null }[];
  siblingRows?: { id: number }[];
}) {
  const setValues: Record<string, unknown>[] = [];
  const wherePredicates: unknown[] = [];
  const returningRows = options.returning;

  const update = jest.fn(() => ({
    set: (values: Record<string, unknown>) => {
      setValues.push(values);
      return {
        where: (predicate: unknown) => {
          wherePredicates.push(predicate);
          const rows = returningRows ?? [];
          return Object.assign(Promise.resolve(rows), {
            returning: () =>
              Promise.resolve(
                rows.map((row) =>
                  row.generationLockToken === "__ECHO__"
                    ? { ...row, generationLockToken: String(setValues[0]?.generationLockToken) }
                    : row,
                ),
              ),
          });
        },
      };
    },
  }));

  const select = jest.fn(() => ({
    from: () => ({
      where: (predicate: unknown) => {
        wherePredicates.push(predicate);
        return { limit: () => Promise.resolve(options.siblingRows ?? []) };
      },
    }),
  }));

  return { db: { update, select } as unknown as Db, setValues, wherePredicates };
}

describe("PayrollRunLockService — generation lock takeover", () => {
  it("stamps a fresh token and lock timestamp when the run is free", async () => {
    const { db, setValues } = makeLockDb({
      returning: [{ id: RUN_ID, generationLockToken: "__ECHO__" }],
    });

    const token = await new PayrollRunLockService(db).acquire(ORG_ID, RUN_ID);

    expect(token).toEqual(expect.any(String));
    expect(setValues[0]?.generationLockToken).toBe(token);
    expect(setValues[0]?.generationLockedAt).toBeInstanceOf(Date);
  });

  it("only takes a held lock over once it is older than the 15 minute TTL", async () => {
    const { db, wherePredicates } = makeLockDb({
      returning: [{ id: RUN_ID, generationLockToken: "__ECHO__" }],
    });
    const before = Date.now();

    await new PayrollRunLockService(db).acquire(ORG_ID, RUN_ID);

    const cutoff = staleCutoffFrom(wherePredicates[0]);
    expect(cutoff).not.toBeNull();
    const age = before - (cutoff?.getTime() ?? 0);
    expect(age).toBeGreaterThanOrEqual(LOCK_TTL_MS - 1_000);
    expect(age).toBeLessThanOrEqual(LOCK_TTL_MS + 1_000);
  });

  it("refuses when a live lock leaves the conditional update matching nothing", async () => {
    const { db } = makeLockDb({ returning: [] });

    await expect(new PayrollRunLockService(db).acquire(ORG_ID, RUN_ID)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("refuses when another acquirer's token came back, never reporting a lock it does not hold", async () => {
    const { db } = makeLockDb({
      returning: [{ id: RUN_ID, generationLockToken: "someone-elses-token" }],
    });

    await expect(new PayrollRunLockService(db).acquire(ORG_ID, RUN_ID)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("clears the lock only for the caller's own token, so a takeover winner survives a loser's release", async () => {
    const { db, setValues, wherePredicates } = makeLockDb({});

    await new PayrollRunLockService(db).release(ORG_ID, RUN_ID, "token-abc");

    expect(setValues[0]).toEqual({ generationLockToken: null, generationLockedAt: null });
    expect(boundValues(wherePredicates[0])).toContain("token-abc");
  });

  it("blocks a second live generation for the same period and lets a stale one through", async () => {
    const held = makeLockDb({ siblingRows: [{ id: 99 }] });
    await expect(
      new PayrollRunLockService(held.db).assertNoOtherActiveGeneration(ORG_ID, "2026-08", RUN_ID),
    ).rejects.toBeInstanceOf(ConflictException);

    const free = makeLockDb({ siblingRows: [] });
    await expect(
      new PayrollRunLockService(free.db).assertNoOtherActiveGeneration(ORG_ID, "2026-08", RUN_ID),
    ).resolves.toBeUndefined();

    const cutoff = staleCutoffFrom(free.wherePredicates[0]);
    const age = Date.now() - (cutoff?.getTime() ?? 0);
    expect(age).toBeGreaterThanOrEqual(LOCK_TTL_MS - 1_000);
    expect(age).toBeLessThanOrEqual(LOCK_TTL_MS + 1_000);
  });
});

interface CloseCapture {
  updates: Record<string, unknown>[];
  events: Record<string, unknown>[];
}

function makeCloseDb(
  run: Record<string, unknown> | null,
  options: { closeReturns?: { id: number }[]; heldRows?: { id: number }[] } = {},
) {
  const capture: CloseCapture = { updates: [], events: [] };
  const closeReturns = options.closeReturns ?? [{ id: RUN_ID }];
  let outerSelectIdx = 0;

  const tx = {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        capture.updates.push(values);
        return { where: () => ({ returning: () => Promise.resolve(closeReturns) }) };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        capture.events.push(values);
        return Promise.resolve([]);
      },
    }),
  };

  const db = {
    query: {
      payrollRuns: { findFirst: jest.fn().mockResolvedValue(run) },
      payrollRunEmployees: { findMany: jest.fn().mockResolvedValue(options.heldRows ?? []) },
    },
    transaction: (fn: (t: typeof tx) => Promise<void>) => fn(tx),
    select: () => {
      const idx = outerSelectIdx++;
      const memberRows =
        idx === 0
          ? [
              {
                id: MEMBERSHIP_ID,
                orgId: ORG_ID,
                userId: USER_ID,
                role: "MEMBER",
                isOwner: false,
                status: "ACTIVE",
              },
            ]
          : [];
      return {
        from: () => ({ where: () => ({ limit: () => Promise.resolve(memberRows) }) }),
      };
    },
  };

  const audit = { log: jest.fn() };
  const service = new LockingService(db as unknown as Db, audit as never, {} as never);
  return { service, capture, audit };
}

describe("LockingService.close — the terminal transition", () => {
  it("closes a published run, stamping the actor membership and writing a CLOSED event", async () => {
    const { service, capture, audit } = makeCloseDb({
      id: RUN_ID,
      orgId: ORG_ID,
      status: "PAYSLIPS_PUBLISHED",
      month: "2026-08",
    });

    const result = await service.close(ORG_ID, USER_ID, RUN_ID);

    expect(result.success).toBe(true);
    expect(capture.updates[0]).toMatchObject({
      status: "CLOSED",
      closedBy: USER_ID,
      closedByMembershipId: MEMBERSHIP_ID,
    });
    expect(capture.updates[0]?.closedAt).toBeInstanceOf(Date);
    expect(capture.events[0]).toMatchObject({
      orgId: ORG_ID,
      runId: RUN_ID,
      type: "CLOSED",
      actorId: USER_ID,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payroll.run_closed", orgId: ORG_ID }),
    );
  });

  it("404s another organisation's run rather than confirming it exists", async () => {
    const { service, capture } = makeCloseDb(null);

    await expect(service.close(OTHER_ORG, USER_ID, RUN_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(capture.updates).toHaveLength(0);
  });

  it("refuses to close a run that has not published payslips", async () => {
    const { service, capture } = makeCloseDb({
      id: RUN_ID,
      orgId: ORG_ID,
      status: "PAID",
      month: "2026-08",
    });

    await expect(service.close(ORG_ID, USER_ID, RUN_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(capture.updates).toHaveLength(0);
  });

  it("refuses to close twice — a CLOSED run has no onward transition", async () => {
    const { service } = makeCloseDb({
      id: RUN_ID,
      orgId: ORG_ID,
      status: "CLOSED",
      month: "2026-08",
    });

    await expect(service.close(ORG_ID, USER_ID, RUN_ID)).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses to close while any payslip is on hold, naming how many", async () => {
    const { service, capture } = makeCloseDb(
      { id: RUN_ID, orgId: ORG_ID, status: "PAYSLIPS_PUBLISHED", month: "2026-08" },
      { heldRows: [{ id: 1 }, { id: 2 }] },
    );

    await expect(service.close(ORG_ID, USER_ID, RUN_ID)).rejects.toThrow(
      "2 payslips are on hold — release or keep holding before closing",
    );
    expect(capture.updates).toHaveLength(0);
  });

  it("aborts when the run drifts out of its read status before the close commits", async () => {
    const { service, capture } = makeCloseDb(
      { id: RUN_ID, orgId: ORG_ID, status: "PAYSLIPS_PUBLISHED", month: "2026-08" },
      { closeReturns: [] },
    );

    await expect(service.close(ORG_ID, USER_ID, RUN_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(capture.events).toHaveLength(0);
  });
});

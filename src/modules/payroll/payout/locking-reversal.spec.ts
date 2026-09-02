import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { LockingService } from "./locking.service";
import type { Db } from "../../../db/drizzle.module";

const ORG_ID = "org-locking";
const USER_ID = "u-actor";
const RUN_ID = 55;
const MEMBERSHIP_ID = "m-actor";

interface TxCapture {
  updates: Record<string, unknown>[];
  events: Record<string, unknown>[];
  transactionCalls: number;
}

function makeDb(
  run: Record<string, unknown> | null,
  options: { reopenReturns?: { id: number }[]; missingSnapshot?: object | null } = {},
) {
  const { reopenReturns = [{ id: RUN_ID }], missingSnapshot = null } = options;
  const capture: TxCapture = { updates: [], events: [], transactionCalls: 0 };
  let outerSelectIdx = 0;

  const tx = {
    query: {
      payrollRunEmployees: { findFirst: jest.fn().mockResolvedValue(missingSnapshot) },
    },
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((values: Record<string, unknown>) => {
        capture.updates.push(values);
        return {
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue(reopenReturns),
          }),
        };
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((values: Record<string, unknown>) => {
        capture.events.push(values);
        return Promise.resolve([]);
      }),
    }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    }),
  };

  const db = {
    query: { payrollRuns: { findFirst: jest.fn().mockResolvedValue(run) } },
    transaction: jest.fn().mockImplementation(async (fn: (t: typeof tx) => Promise<void>) => {
      capture.transactionCalls++;
      return fn(tx);
    }),
    select: jest.fn().mockImplementation(() => {
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
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(memberRows) }),
        }),
      };
    }),
  };

  return { db: db as unknown as Db, capture };
}

function baseRun(status: string) {
  return { id: RUN_ID, orgId: ORG_ID, status, month: "2026-08" };
}

function build(
  run: Record<string, unknown> | null,
  options?: { reopenReturns?: { id: number }[]; missingSnapshot?: object | null },
) {
  const { db, capture } = makeDb(run, options);
  const audit = { log: jest.fn() };
  const generate = { postPayrollLock: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new LockingService(db, audit as never, generate as never),
    capture,
    audit,
  };
}

describe("LockingService.reopen — the reversal transition", () => {
  it("moves a LOCKED run to REOPENED and records the reason on the run", async () => {
    const { service, capture } = build(baseRun("LOCKED"));

    await service.reopen(ORG_ID, USER_ID, RUN_ID, "correction to overtime hours");

    expect(capture.transactionCalls).toBe(1);
    expect(capture.updates[0]).toMatchObject({
      status: "REOPENED",
      reopenedBy: USER_ID,
      reopenedByMembershipId: MEMBERSHIP_ID,
      reopenReason: "correction to overtime hours",
    });
  });

  it("writes a REOPENED run event carrying the reason, so the reversal is auditable", async () => {
    const { service, capture } = build(baseRun("LOCKED"));

    await service.reopen(ORG_ID, USER_ID, RUN_ID, "bank details corrected");

    expect(capture.events).toHaveLength(1);
    expect(capture.events[0]).toMatchObject({
      orgId: ORG_ID,
      runId: RUN_ID,
      type: "REOPENED",
      actorId: USER_ID,
      reason: "bank details corrected",
    });
  });

  it("rejects a reopen of a PAID run rather than un-paying it", async () => {
    const { service, capture } = build(baseRun("PAID"));

    await expect(service.reopen(ORG_ID, USER_ID, RUN_ID, "why")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(capture.transactionCalls).toBe(0);
  });

  it("rejects a reopen of a CLOSED run", async () => {
    const { service } = build(baseRun("CLOSED"));

    await expect(service.reopen(ORG_ID, USER_ID, RUN_ID, "why")).rejects.toThrow(
      "Cannot reopen run in status CLOSED",
    );
  });

  it("404s a run belonging to another org instead of reopening it", async () => {
    const { service, capture } = build(null);

    await expect(service.reopen(ORG_ID, USER_ID, RUN_ID, "why")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(capture.transactionCalls).toBe(0);
  });

  it("conflicts when the run left its status between the read and the reopen commit", async () => {
    const { service } = build(baseRun("LOCKED"), { reopenReturns: [] });

    await expect(service.reopen(ORG_ID, USER_ID, RUN_ID, "why")).rejects.toThrow(
      `Payroll run ${RUN_ID} left status LOCKED before the reopen committed`,
    );
  });
});

describe("LockingService.lock — re-lock and pre-lock guards", () => {
  it("rejects locking a run that is already LOCKED so the posting intent is emitted once", async () => {
    const { service, capture } = build(baseRun("LOCKED"));

    await expect(service.lock(ORG_ID, USER_ID, RUN_ID)).rejects.toThrow(
      "Cannot lock run in status LOCKED",
    );
    expect(capture.transactionCalls).toBe(0);
  });

  it("rejects locking a run that has not been approved", async () => {
    const { service } = build(baseRun("PENDING_APPROVAL"));

    await expect(service.lock(ORG_ID, USER_ID, RUN_ID)).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses to lock when a payee has no calculation snapshot", async () => {
    const { service } = build(baseRun("APPROVED"), {
      missingSnapshot: { id: 9, userId: "u-payee", workerId: null },
    });

    await expect(service.lock(ORG_ID, USER_ID, RUN_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

jest.mock("../../common/tenant", () => ({
  forEachOrg: async (
    _db: unknown,
    _name: string,
    fn: (tx: unknown, orgId: string) => Promise<void>,
  ) => {
    await fn((globalThis as { __cronTx?: unknown }).__cronTx, "org1");
    return { organizations: 1, succeeded: 1, failed: 0 };
  },
}));

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CronInvitationExpiryService } from "./cron-invitation-expiry.service";
import { SeatLedgerService } from "../billing/core/seat-ledger.service";
import type { SeatEventInput, SeatEventRecord } from "../billing/core/seat-ledger.service";

const dialect = new PgDialect();

interface TxRef {
  where: SQL | null;
}

function makeTx(rows: Array<{ id: string }>): { ref: TxRef } {
  const ref: TxRef = { where: null };
  const tx = {
    update: (_table: unknown) => ({
      set: (_values: unknown) => ({
        where: (cond: SQL) => {
          ref.where = cond;
          return { returning: (_cols: unknown) => Promise.resolve(rows) };
        },
      }),
    }),
  };
  (globalThis as { __cronTx?: unknown }).__cronTx = tx;
  return { ref };
}

async function build(rows: Array<{ id: string }>) {
  const { ref } = makeTx(rows);

  const recorded: SeatEventInput[] = [];
  const seatLedger = {
    recordSeatEvent: jest.fn().mockImplementation(
      async (input: SeatEventInput, _executor: unknown): Promise<SeatEventRecord> => {
        recorded.push(input);
        return {
          id: recorded.length,
          eventType: input.eventType,
          subjectId: input.subjectId,
          quantityDelta: -1,
          billedQuantityAfter: 0,
          effectiveAt: new Date(),
          replayed: false,
        };
      },
    ),
  };

  const mod = await Test.createTestingModule({
    providers: [
      CronInvitationExpiryService,
      { provide: DRIZZLE, useValue: {} },
      { provide: SeatLedgerService, useValue: seatLedger },
    ],
  }).compile();

  return {
    service: mod.get(CronInvitationExpiryService),
    seatLedger,
    recorded,
    ref,
  };
}

describe("CronInvitationExpiryService — sweepExpiredInvitations", () => {
  it("returns the count of invitations transitioned", async () => {
    const { service } = await build([{ id: "inv1" }, { id: "inv2" }]);
    const result = await service.sweepExpiredInvitations();
    expect(result.expired).toBe(2);
  });

  it("emits one INVITE_EXPIRED seat event per transitioned invitation", async () => {
    const { service, recorded } = await build([{ id: "inv1" }, { id: "inv2" }]);
    await service.sweepExpiredInvitations();

    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({
      eventType: "INVITE_EXPIRED",
      subjectId: "inv1",
      orgId: "org1",
    });
    expect(recorded[1]).toMatchObject({
      eventType: "INVITE_EXPIRED",
      subjectId: "inv2",
      orgId: "org1",
    });
  });

  it("assigns a deterministic idempotency key to each event", async () => {
    const { service, recorded } = await build([{ id: "inv1" }, { id: "inv2" }]);
    await service.sweepExpiredInvitations();

    expect(recorded[0]?.idempotencyKey).toBe("invite-expired:inv1");
    expect(recorded[1]?.idempotencyKey).toBe("invite-expired:inv2");
  });

  it("passes the transaction as executor so the update and event are atomic", async () => {
    const { service, seatLedger } = await build([{ id: "inv1" }]);
    await service.sweepExpiredInvitations();

    const [[, executor]] = seatLedger.recordSeatEvent.mock.calls as [[SeatEventInput, unknown]];
    expect(executor).toBeDefined();
  });

  it("update predicate includes status = PENDING", async () => {
    const { service, ref } = await build([]);
    await service.sweepExpiredInvitations();

    const cond = ref.where;
    if (cond === null) throw new Error("where predicate was never captured");
    const rendered = dialect.sqlToQuery(cond);

    expect(rendered.sql).toContain('"status"');
    expect(rendered.params).toContain("PENDING");
  });

  it("update predicate includes expires_at < now", async () => {
    const { service, ref } = await build([]);
    await service.sweepExpiredInvitations();

    const cond = ref.where;
    if (cond === null) throw new Error("where predicate was never captured");
    const rendered = dialect.sqlToQuery(cond);

    expect(rendered.sql).toContain('"invitations"."expires_at" <');

    const timestamps = rendered.params.filter(
      (p) => typeof p === "string" && !Number.isNaN(Date.parse(p)) && p.includes("T"),
    );
    expect(timestamps).toHaveLength(1);
  });

  it("binds the cutoff as a driver-serialisable value rather than a bare Date", async () => {
    const { service, ref } = await build([]);
    await service.sweepExpiredInvitations();

    const cond = ref.where;
    if (cond === null) throw new Error("where predicate was never captured");

    expect(dialect.sqlToQuery(cond).params.some((p) => p instanceof Date)).toBe(false);
  });

  it("is idempotent — second run emits no events when the first already transitioned them", async () => {
    const { service: firstRun, seatLedger: sl1 } = await build([{ id: "inv1" }]);
    await firstRun.sweepExpiredInvitations();
    expect(sl1.recordSeatEvent).toHaveBeenCalledTimes(1);

    const { service: secondRun, seatLedger: sl2 } = await build([]);
    await secondRun.sweepExpiredInvitations();
    expect(sl2.recordSeatEvent).not.toHaveBeenCalled();
  });

  it("does not emit events when the update transitions zero rows", async () => {
    const { service, seatLedger } = await build([]);
    await service.sweepExpiredInvitations();
    expect(seatLedger.recordSeatEvent).not.toHaveBeenCalled();
  });

  it("returns zero when no invitations are eligible", async () => {
    const { service } = await build([]);
    const result = await service.sweepExpiredInvitations();
    expect(result.expired).toBe(0);
  });
});

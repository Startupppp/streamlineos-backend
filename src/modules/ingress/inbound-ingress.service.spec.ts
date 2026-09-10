import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.types";
import { InboundIngressService } from "./inbound-ingress.service";
import type { InboundCommunicationEvent } from "./inbound-event";

jest.mock("../../common/workflow/workflow-store", () => ({
  startRun: jest.fn().mockResolvedValue("run-1"),
}));

import { startRun } from "../../common/workflow/workflow-store";

const FIXTURE: InboundCommunicationEvent = {
  organizationId: "org-1",
  channel: "email",
  provider: "fixture",
  providerMessageId: "msg-1",
  occurredAt: "2026-08-23T10:00:00.000Z",
  subject: "Quote for Q3",
  participants: [{ address: "priya@example.com", role: "from" }],
};

interface DbOptions {
  /** Whether the organisation exists. */
  organisation: boolean;
  /** null means the insert won a race; a row means the delivery was already seen. */
  receiptConflict: { inboundEventId: string; status: string } | null;
}

function makeDb(options: DbOptions): Db & { inserted: boolean } {
  let selectCall = 0;
  const state = { inserted: false };

  const db = {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockImplementation(() => ({
        where: jest.fn().mockImplementation(() => ({
          limit: jest.fn().mockImplementation(async () => {
            selectCall += 1;
            // First read: does the organisation exist. Second: the existing receipt.
            if (selectCall === 1) return options.organisation ? [{ id: "org-1" }] : [];
            return options.receiptConflict ? [options.receiptConflict] : [];
          }),
        })),
      })),
    })),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation(() => ({
        onConflictDoNothing: jest.fn().mockImplementation(() => ({
          returning: jest.fn().mockImplementation(async () => {
            if (options.receiptConflict) return [];
            state.inserted = true;
            return [{ inboundEventId: "receipt-1" }];
          }),
        })),
      })),
    })),
    update: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockImplementation(() => ({
        where: jest.fn().mockResolvedValue(undefined),
      })),
    })),
  } as unknown as Db;

  return Object.assign(db, {
    get inserted() {
      return state.inserted;
    },
  }) as Db & { inserted: boolean };
}

describe("InboundIngressService.accept", () => {
  beforeEach(() => {
    (startRun as jest.Mock).mockClear();
  });

  it("accepts a new delivery and starts a durable run for it", async () => {
    const db = makeDb({ organisation: true, receiptConflict: null });
    const outcome = await new InboundIngressService(db).accept(FIXTURE, "org-1");

    expect(outcome).toMatchObject({ status: "accepted", inboundEventId: "receipt-1" });
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  /**
   * The run is keyed on the receipt, so a redelivered start resumes the run it
   * already began rather than beginning a second.
   */
  it("keys the run on the receipt so a restart resumes rather than duplicates", async () => {
    const db = makeDb({ organisation: true, receiptConflict: null });
    await new InboundIngressService(db).accept(FIXTURE, "org-1");

    expect(startRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ causationEventId: "receipt-1" }),
    );
  });

  it("rejects a malformed event before anything is written", async () => {
    const db = makeDb({ organisation: true, receiptConflict: null });
    const service = new InboundIngressService(db);

    await expect(service.accept({ ...FIXTURE, participants: [] }, "org-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(db.inserted).toBe(false);
    expect(startRun).not.toHaveBeenCalled();
  });

  /** A mistyped or forged tenant leaves no row behind to be reconciled later. */
  it("rejects an event for an unknown organisation without creating anything", async () => {
    const db = makeDb({ organisation: false, receiptConflict: null });
    const service = new InboundIngressService(db);

    await expect(service.accept(FIXTURE, "org-1")).rejects.toBeInstanceOf(NotFoundException);
    expect(db.inserted).toBe(false);
    expect(startRun).not.toHaveBeenCalled();
  });

  // The organisation EXISTS here — that is the point; existence was the only check.
  it("refuses an event naming another tenant, even one that exists", async () => {
    const db = makeDb({ organisation: true, receiptConflict: null });
    const service = new InboundIngressService(db);

    await expect(service.accept(FIXTURE, "org-2")).rejects.toBeInstanceOf(NotFoundException);
    expect(db.inserted).toBe(false);
    expect(startRun).not.toHaveBeenCalled();
  });

  it("refuses an event from a caller with no organisation at all", async () => {
    const db = makeDb({ organisation: true, receiptConflict: null });
    const service = new InboundIngressService(db);

    await expect(service.accept(FIXTURE, null)).rejects.toBeInstanceOf(NotFoundException);
    expect(db.inserted).toBe(false);
    expect(startRun).not.toHaveBeenCalled();
  });

  /**
   * Two runs resolving the same unknown sender concurrently is exactly how a
   * duplicate party gets created, so the second caller is told to retry rather
   * than allowed to race.
   */
  it("rejects a concurrent duplicate while the first is still in flight", async () => {
    const db = makeDb({
      organisation: true,
      receiptConflict: { inboundEventId: "receipt-1", status: "RECEIVED" },
    });

    await expect(new InboundIngressService(db).accept(FIXTURE, "org-1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(startRun).not.toHaveBeenCalled();
  });

  it("returns the same answer for a redelivery of something already processed", async () => {
    const db = makeDb({
      organisation: true,
      receiptConflict: { inboundEventId: "receipt-1", status: "PROCESSED" },
    });

    const outcome = await new InboundIngressService(db).accept(FIXTURE, "org-1");

    expect(outcome).toEqual({ status: "duplicate", inboundEventId: "receipt-1" });
    expect(startRun).not.toHaveBeenCalled();
  });
});

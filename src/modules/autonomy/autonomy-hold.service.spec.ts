jest.mock("../../common/workflow/workflow-store", () => ({
  startRun: jest.fn().mockResolvedValue("run-1"),
}));

import { ConflictException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.types";
import {
  autonomousDecisions,
  autonomyHolds,
  crmOutboundClassStops,
  crmOutboundMessages,
  organizationMembers,
  quotes,
} from "../../db/schema";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../test/postgres-error-fixture";
import type { NotificationsService } from "../notifications/notifications.service";
import type { QuotesService } from "../quotes/quotes.service";
import { AutonomyHoldService } from "./autonomy-hold.service";
import type { AutonomyScoringService } from "./autonomy-scoring.service";

/**
 * Placing a hold, and telling somebody about it.
 *
 * The hold is the only thing standing between an autonomous decision and a
 * customer's inbox, and it is only a safeguard if a person hears about it in
 * time. A hold on a deal nobody owns used to notify nobody at all — and then
 * sent sixty seconds later anyway, which is the failure the notification exists
 * to prevent arriving on exactly the quotes least likely to have been read.
 */

const ORG = "org-1";

function query<T>(rows: T[]) {
  return {
    then: (resolve: (value: T[]) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
    limit: async () => rows,
  };
}

function makeService(options: {
  assignedToId: string | null;
  admins: string[];
  create: jest.Mock;
  holdInsertError?: Error;
}): AutonomyHoldService {
  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table === organizationMembers)
          return { where: () => query(options.admins.map((userId) => ({ userId }))) };

        if (table === quotes)
          return {
            leftJoin: () => ({
              where: () =>
                query([{ assignedToId: options.assignedToId, quoteSubject: "Acme Q3 proposal" }]),
            }),
          };

        throw new Error("unexpected read");
      },
    }),
    insert: (table: unknown) => ({
      values: () => ({
        returning: async () => {
          if (table === autonomyHolds && options.holdInsertError) throw options.holdInsertError;
          return [{ id: table === autonomousDecisions ? "decision-1" : "hold-1" }];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: () => ({ where: async () => (table === autonomyHolds ? [] : []) }),
    }),
  } as unknown as Db;

  return new AutonomyHoldService(
    db,
    { settingsFor: async () => ({ holdWindowSeconds: 60 }) } as unknown as AutonomyScoringService,
    { create: options.create } as unknown as NotificationsService,
    {} as unknown as QuotesService,
  );
}

describe("AutonomyHoldService.holdQuoteSend", () => {
  it("tells the person who owns the deal", async () => {
    const create = jest.fn().mockResolvedValue({ id: 1 });
    const service = makeService({ assignedToId: "user-owner", admins: ["user-admin"], create });

    await service.holdQuoteSend({
      organizationId: ORG,
      quoteId: 42,
      summary: "Drafted it and decided to send it.",
      confidence: 0.95,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-owner" }));
  });

  it("falls back to the organisation's administrators when nobody owns the deal", async () => {
    const create = jest.fn().mockResolvedValue({ id: 1 });
    const service = makeService({
      assignedToId: null,
      admins: ["user-owner-of-org", "user-admin"],
      create,
    });

    await service.holdQuoteSend({
      organizationId: ORG,
      quoteId: 42,
      summary: "Drafted it and decided to send it.",
      confidence: 0.95,
    });

    expect(create.mock.calls.map((call) => (call[0] as { userId: string }).userId)).toEqual([
      "user-owner-of-org",
      "user-admin",
    ]);
  });

  it("still places the hold when there is nobody at all to tell", async () => {
    // The hold existing matters more than the notification landing; the feed
    // still shows it, and a swallowed failure would be the worse bug.
    const create = jest.fn();
    const service = makeService({ assignedToId: null, admins: [], create });

    const held = await service.holdQuoteSend({
      organizationId: ORG,
      quoteId: 42,
      summary: "Drafted it and decided to send it.",
      confidence: 0.95,
    });

    expect(create).not.toHaveBeenCalled();
    expect(held.autonomyHoldId).toBe("hold-1");
  });

  it("does not let one failed notification stop the others", async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(new Error("push gateway is down"))
      .mockResolvedValue({ id: 2 });
    const service = makeService({ assignedToId: null, admins: ["a", "b"], create });

    await expect(
      service.holdQuoteSend({
        organizationId: ORG,
        quoteId: 42,
        summary: "Drafted it and decided to send it.",
        confidence: 0.95,
      }),
    ).resolves.toMatchObject({ autonomyHoldId: "hold-1" });

    expect(create).toHaveBeenCalledTimes(2);
  });

  it("answers 409 when the quote already has a live hold", async () => {
    // uniq_autonomy_holds_live_quote (one live hold per quote), as drizzle surfaces it.
    const service = makeService({
      assignedToId: "user-owner",
      admins: [],
      create: jest.fn(),
      holdInsertError: drizzleUniqueViolation("uniq_autonomy_holds_live_quote"),
    });

    await expect(
      service.holdQuoteSend({
        organizationId: ORG,
        quoteId: 42,
        summary: "Drafted it and decided to send it.",
        confidence: 0.95,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rethrows any other database error from the hold insert untouched", async () => {
    const fkViolation = drizzlePostgresError("23503", "some_fk");
    const service = makeService({
      assignedToId: "user-owner",
      admins: [],
      create: jest.fn(),
      holdInsertError: fkViolation,
    });

    await expect(
      service.holdQuoteSend({
        organizationId: ORG,
        quoteId: 42,
        summary: "Drafted it and decided to send it.",
        confidence: 0.95,
      }),
    ).rejects.toBe(fkViolation);
  });
});


/**
 * Stopping a message stops its class for that party.
 *
 * Ticket 07's US8, and it was half-built: `outbound.service.ts` read
 * `crm_outbound_class_stops` at send time and nothing anywhere inserted a row,
 * so the table was always empty and the guardrail always passed. A person who
 * stopped a nudge got the next nudge.
 */
describe("AutonomyHoldService.cancelHold stops the class, not just the message", () => {
  interface CancelFixture {
    /** What the hold row carries. Null is a quote hold — no message, no class. */
    outboundMessageId: string | null;
    /** A live stop already on file for this party and class. */
    existingStop?: boolean;
    /** Make the insert throw, to prove the cancellation still succeeds. */
    insertThrows?: boolean;
  }

  function makeCancelService(fixture: CancelFixture) {
    const inserted: Record<string, unknown>[] = [];

    const db = {
      select: () => ({
        from: (table: unknown) => {
          if (table === crmOutboundMessages)
            return {
              where: () =>
                query([{ partyId: "party-9", outboundClass: "nudge" }]),
            };
          if (table === crmOutboundClassStops)
            return {
              where: () => query(fixture.existingStop ? [{ id: "stop-existing" }] : []),
            };
          if (table === autonomyHolds) return { where: () => query([{ status: "held" }]) };
          throw new Error("unexpected read");
        },
      }),
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => {
          if (table === crmOutboundClassStops) {
            if (fixture.insertThrows) return Promise.reject(new Error("stop write failed"));
            inserted.push(row);
          }
          return Promise.resolve(undefined);
        },
      }),
      update: (table: unknown) => ({
        set: () => ({
          where: (() => {
            const chain = {
              returning: async () =>
                table === autonomyHolds
                  ? [
                      {
                        id: "hold-1",
                        decisionId: "decision-1",
                        outboundMessageId: fixture.outboundMessageId,
                      },
                    ]
                  : [],
              then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
            };
            return () => chain;
          })(),
        }),
      }),
    } as unknown as Db;

    const service = new AutonomyHoldService(
      db,
      { settingsFor: async () => ({ holdWindowSeconds: 60 }) } as unknown as AutonomyScoringService,
      { create: jest.fn() } as unknown as NotificationsService,
      {} as unknown as QuotesService,
    );
    return { service, inserted };
  }

  it("records a stop for the party and class of the message that was cancelled", async () => {
    const { service, inserted } = makeCancelService({ outboundMessageId: "msg-1" });

    await expect(service.cancelHold(ORG, "user-1", "hold-1", "not now")).resolves.toEqual({
      cancelled: true,
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      organizationId: ORG,
      partyId: "party-9",
      outboundClass: "nudge",
      outboundMessageId: "msg-1",
      stoppedByUserId: "user-1",
      reason: "not now",
    });
  });

  /**
   * Per class, not per party. Somebody who does not want chasing may still want
   * the renewal conversation, and one cancellation is not consent to go silent
   * everywhere.
   */
  it("stops only the cancelled message's class", async () => {
    const { service, inserted } = makeCancelService({ outboundMessageId: "msg-1" });
    await service.cancelHold(ORG, "user-1", "hold-1");
    expect(inserted[0]).toMatchObject({ outboundClass: "nudge" });
  });

  it("records nothing for a quote hold, which carries no class to stop", async () => {
    const { service, inserted } = makeCancelService({ outboundMessageId: null });
    await expect(service.cancelHold(ORG, "user-1", "hold-1")).resolves.toEqual({ cancelled: true });
    expect(inserted).toHaveLength(0);
  });

  it("does not write a second stop over a live one", async () => {
    const { service, inserted } = makeCancelService({
      outboundMessageId: "msg-1",
      existingStop: true,
    });
    await service.cancelHold(ORG, "user-1", "hold-1");
    expect(inserted).toHaveLength(0);
  });

  /**
   * The cancellation has already committed by this point. Failing here would
   * turn a successful stop into a 500 and invite the person to press it again.
   */
  it("still reports the cancellation when the stop cannot be written", async () => {
    const { service } = makeCancelService({ outboundMessageId: "msg-1", insertThrows: true });
    await expect(service.cancelHold(ORG, "user-1", "hold-1")).resolves.toEqual({ cancelled: true });
  });
});

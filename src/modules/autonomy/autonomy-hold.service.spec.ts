jest.mock("../../common/workflow/workflow-store", () => ({
  startRun: jest.fn().mockResolvedValue("run-1"),
}));

import type { Db } from "../../db/drizzle.types";
import { autonomousDecisions, autonomyHolds, organizationMembers, quotes } from "../../db/schema";
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
  const chain = {
    then: (resolve: (value: T[]) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
    orderBy: () => chain,
    limit: async () => rows,
  };
  return chain;
}

function makeService(options: {
  assignedToId: string | null;
  admins: string[];
  create: jest.Mock;
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
        returning: async () => [
          { id: table === autonomousDecisions ? "decision-1" : "hold-1" },
        ],
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
});

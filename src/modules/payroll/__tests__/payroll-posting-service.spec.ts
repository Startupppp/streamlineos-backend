import { PayrollPostingService } from "../payroll-posting.service";
import { AdapterRejection } from "../../accounting/adapters/posting-command.types";
import { systemActor } from "../../../common/auth/system-actor";
import {
  PayrollPayoutPostingIntentConsumer,
  PAYROLL_RUN_PAYOUT_POSTING_INTENT_EVENT,
} from "../payout/payroll-payout-posting-intent.consumer";
import { OutboxConsumerRegistry } from "../../../common/outbox/outbox-consumer.registry";
import type { OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";

const ORG_ID = "org-pay-post";
const RUN_ID = 99;
const MONTH = "2026-08";
const NET_PAISE_STR = "400000";

const u = systemActor("payroll.run.payout-posting", ORG_ID, "u-actor");

function makePosting(submitResult: "ok" | Error) {
  return {
    submit: jest.fn().mockImplementation(() =>
      submitResult === "ok"
        ? Promise.resolve({ journalId: "j-1", journalNumber: "J-001", replayed: false })
        : Promise.reject(submitResult),
    ),
    submitPayrollRun: jest.fn().mockResolvedValue(undefined),
  };
}

function makeBooks(book: { baseCurrency: string } | null | Error) {
  return {
    findDefault: jest.fn().mockImplementation(() => {
      if (book instanceof Error) return Promise.reject(book);
      return Promise.resolve(book);
    }),
  };
}

function build(
  bookResult: { baseCurrency: string } | null | Error,
  submitResult: "ok" | Error,
) {
  const posting = makePosting(submitResult);
  const books = makeBooks(bookResult);
  const svc = new PayrollPostingService(posting as never, books as never);
  return { svc, posting, books };
}

describe("PayrollPostingService.postPaid — genuine failures propagate for outbox retry", () => {
  it("propagates a submit failure so the consumer can mark the intent FAILED and retry", async () => {
    const submitError = new Error("accounting-period-closed");
    const { svc } = build({ baseCurrency: "INR" }, submitError);

    await expect(svc.postPaid(u, RUN_ID, MONTH, NET_PAISE_STR)).rejects.toThrow(
      "accounting-period-closed",
    );
  });

  it("propagates a transient book-lookup failure so the intent stays retryable", async () => {
    const lookupError = new Error("connection-timeout");
    const { svc } = build(lookupError, "ok");

    await expect(svc.postPaid(u, RUN_ID, MONTH, NET_PAISE_STR)).rejects.toThrow(
      "connection-timeout",
    );
  });
});

describe("PayrollPostingService.postPaid — Accounting-not-enabled is a skip, not a retry loop", () => {
  it("returns without throwing when no book exists (accounting never enabled)", async () => {
    const { svc, posting } = build(null, "ok");

    await expect(svc.postPaid(u, RUN_ID, MONTH, NET_PAISE_STR)).resolves.toBeUndefined();

    expect(posting.submit).not.toHaveBeenCalled();
  });

  it("returns without throwing when the adapter raises BOOK_NOT_ENABLED", async () => {
    const rejection = new AdapterRejection("BOOK_NOT_ENABLED", "no book");
    const { svc, posting } = build(rejection, "ok");

    await expect(svc.postPaid(u, RUN_ID, MONTH, NET_PAISE_STR)).resolves.toBeUndefined();

    expect(posting.submit).not.toHaveBeenCalled();
  });
});

describe("PayrollPostingService.postPaid — immutable paid-run outcome", () => {
  it("a net of zero skips posting without error (run stays paid, nothing to post)", async () => {
    const { svc, posting } = build({ baseCurrency: "INR" }, "ok");

    await expect(svc.postPaid(u, RUN_ID, MONTH, "0")).resolves.toBeUndefined();

    expect(posting.submit).not.toHaveBeenCalled();
  });

  it("a successful post resolves without error, preserving the paid run outcome", async () => {
    const { svc, posting } = build({ baseCurrency: "INR" }, "ok");

    await expect(svc.postPaid(u, RUN_ID, MONTH, NET_PAISE_STR)).resolves.toBeUndefined();

    expect(posting.submit).toHaveBeenCalledTimes(1);
  });
});

describe("PAY-POST seam — consumer marks FAILED (retryable) on a genuine posting failure", () => {
  function makeConsumerDb(inboxStatuses: string[]) {
    const setMock = jest.fn().mockImplementation((patch: Record<string, unknown>) => {
      if (typeof patch.status === "string") inboxStatuses.push(patch.status);
      return { where: jest.fn().mockResolvedValue([]) };
    });
    return {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1 }]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({ set: setMock }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    };
  }

  function makePayoutEvent(): OutboxEventRow {
    return {
      outboxEventId: 1,
      eventId: "event-seam-proof",
      organizationId: ORG_ID,
      aggregateType: "payroll_run",
      aggregateId: String(RUN_ID),
      aggregateVersion: 2,
      schemaVersion: 1,
      causationId: null,
      correlationId: null,
      actorMembershipId: null,
      audience: "INTERNAL",
      lifecycleState: "ACTIVE",
      deliveryState: "IN_FLIGHT",
      eventType: PAYROLL_RUN_PAYOUT_POSTING_INTENT_EVENT,
      payload: {
        runId: RUN_ID,
        month: MONTH,
        net: NET_PAISE_STR,
        actorUserId: "u-actor",
        orgId: ORG_ID,
      },
      occurredAt: new Date(),
      publishedAt: null,
      leaseExpiresAt: new Date(Date.now() + 30_000),
      retryCount: 0,
      lastError: null,
      deadLetteredAt: null,
      createdAt: new Date(),
    };
  }

  it("posting failure rethrows from the consumer so the outbox retries, and marks inbox FAILED not COMPLETED", async () => {
    const inboxStatuses: string[] = [];
    const db = makeConsumerDb(inboxStatuses);

    const submitError = new Error("ledger-unavailable");
    const posting = makePosting(submitError);
    const books = makeBooks({ baseCurrency: "INR" });
    const svc = new PayrollPostingService(posting as never, books as never);

    const registry = new OutboxConsumerRegistry();
    const consumer = new PayrollPayoutPostingIntentConsumer(db as never, svc, registry);
    consumer.onModuleInit();

    await expect(consumer.handle(makePayoutEvent())).rejects.toThrow("ledger-unavailable");

    expect(inboxStatuses).toContain("FAILED");
    expect(inboxStatuses).not.toContain("COMPLETED");
  });

  it("crash/restart replay: second delivery with same eventId is skipped — no double-post", async () => {
    const posting = makePosting("ok");
    const books = makeBooks({ baseCurrency: "INR" });
    const svc = new PayrollPostingService(posting as never, books as never);

    const firstDb = makeConsumerDb([]);
    const secondDb = (() => {
      const claimReturnsEmpty = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        }),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        }),
      };
      return claimReturnsEmpty;
    })();

    const registry = new OutboxConsumerRegistry();
    const consumerFirst = new PayrollPayoutPostingIntentConsumer(firstDb as never, svc, registry);
    consumerFirst.onModuleInit();
    await consumerFirst.handle(makePayoutEvent());
    expect(posting.submit).toHaveBeenCalledTimes(1);

    const consumerSecond = new PayrollPayoutPostingIntentConsumer(secondDb as never, svc, registry);
    await consumerSecond.handle(makePayoutEvent());

    expect(posting.submit).toHaveBeenCalledTimes(1);
  });
});

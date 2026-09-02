import { OutboxConsumerRegistry } from "../../../common/outbox/outbox-consumer.registry";
import type { OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";
import {
  PayrollPayoutPostingIntentConsumer,
  PAYROLL_RUN_PAYOUT_POSTING_INTENT_EVENT,
} from "../payout/payroll-payout-posting-intent.consumer";

const ORG_ID = "org-payroll-payout";
const RUN_ID = 77;
const MONTH = "2026-08";
const NET = "400000";
const ACTOR_USER_ID = "u-actor";

function makeEvent(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: "event-payout-posting-intent-1",
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
      net: NET,
      actorUserId: ACTOR_USER_ID,
      orgId: ORG_ID,
    },
    occurredAt: new Date(),
    publishedAt: null,
    leaseExpiresAt: new Date(Date.now() + 30_000),
    retryCount: 0,
    lastError: null,
    deadLetteredAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeDb(claimResult: { id: number }[] = [{ id: 1 }]) {
  const insert = jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({
      onConflictDoNothing: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(claimResult),
      }),
    }),
  });
  const update = jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  });
  const select = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    }),
  });
  return { insert, update, select };
}

function build(claimResult?: { id: number }[]) {
  const db = makeDb(claimResult);
  const payrollPosting = { postPaid: jest.fn().mockResolvedValue(undefined) };
  const registry = new OutboxConsumerRegistry();
  const consumer = new PayrollPayoutPostingIntentConsumer(
    db as never,
    payrollPosting as never,
    registry,
  );
  return { consumer, payrollPosting, registry, db };
}

describe("payout posting intent consumer — a marked-paid run always reaches accounting", () => {
  it("registers itself for payroll.run.payout-posting-intent so the event is never orphaned", () => {
    const { consumer, registry } = build();
    consumer.onModuleInit();
    expect(registry.get(PAYROLL_RUN_PAYOUT_POSTING_INTENT_EVENT)).toBe(consumer);
  });

  it("posts the bank-disbursement journal with the payload's run, month and net", async () => {
    const { consumer, payrollPosting } = build();

    await consumer.handle(makeEvent());

    expect(payrollPosting.postPaid).toHaveBeenCalledTimes(1);
    expect(payrollPosting.postPaid).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID }),
      RUN_ID,
      MONTH,
      NET,
    );
  });

  it("does nothing when the inbox claim is lost, so a redelivery cannot double-post", async () => {
    const { consumer, payrollPosting } = build([]);

    await consumer.handle(makeEvent());

    expect(payrollPosting.postPaid).not.toHaveBeenCalled();
  });

  it("rejects a payload whose orgId disagrees with the envelope instead of posting cross-tenant", async () => {
    const { consumer, payrollPosting } = build();

    await consumer.handle(
      makeEvent({
        payload: {
          runId: RUN_ID,
          month: MONTH,
          net: NET,
          actorUserId: ACTOR_USER_ID,
          orgId: "org-attacker",
        },
      }),
    );

    expect(payrollPosting.postPaid).not.toHaveBeenCalled();
  });

  it("rejects a malformed payload without posting", async () => {
    const { consumer, payrollPosting } = build();

    await consumer.handle(makeEvent({ payload: { runId: "not-a-number" } }));

    expect(payrollPosting.postPaid).not.toHaveBeenCalled();
  });

  it("re-throws a posting failure so the outbox publisher retries rather than losing the journal", async () => {
    const { consumer, payrollPosting } = build();
    payrollPosting.postPaid.mockRejectedValue(new Error("accounting-period-closed"));

    await expect(consumer.handle(makeEvent())).rejects.toThrow("accounting-period-closed");
  });
});

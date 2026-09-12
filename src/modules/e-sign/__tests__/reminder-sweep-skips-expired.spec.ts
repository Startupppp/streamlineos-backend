import { SignEnvelopeSweepsService } from "../sign-envelope-sweeps.service";
import type { Db } from "../../../db/drizzle.module";

const ORG = "org-reminders";

/**
 * The reminder and expiration sweeps are scheduled separately and may run in
 * either order. A reminder re-issues the signing token, so reminding an
 * envelope that is already past its expiry emails a fresh link to a document
 * the next expiration pass closes. The due filter is where that is refused,
 * so the preview and the live run agree.
 */
function envelope(overrides: Record<string, unknown>) {
  return {
    id: 1,
    orgId: ORG,
    status: "sent",
    title: "T",
    reminderEnabled: true,
    reminderSentCount: 0,
    reminderMaxCount: 3,
    reminderFirstAfterDays: 1,
    reminderRepeatDays: 1,
    sentAt: new Date("2026-06-01T00:00:00Z"),
    lastReminderAt: null,
    expiresAt: null,
    senderMembershipId: null,
    ...overrides,
  };
}

function makeService(rows: unknown[]) {
  const db = {
    query: {
      signEnvelopes: { findMany: jest.fn(async () => rows), findFirst: jest.fn(async () => undefined) },
      organizationMembers: { findFirst: jest.fn(async () => undefined) },
    },
  } as unknown as Db;
  const listForEnvelope = jest.fn(async () => []);
  const service = new SignEnvelopeSweepsService(
    db,
    { record: jest.fn() } as never,
    { generateSigningToken: jest.fn(), hash: jest.fn(), buildSigningUrl: jest.fn() } as never,
    { sendReminder: jest.fn() } as never,
    { listForEnvelope } as never,
    { emitEnvelopeEvent: jest.fn() } as never,
  );
  return { service, listForEnvelope };
}

describe("reminder sweep and an envelope past its expiry", () => {
  it("does not consider an envelope whose expiry has passed", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const { service, listForEnvelope } = makeService([envelope({ id: 7, expiresAt: yesterday })]);

    const preview = await service.previewSweep(ORG, "reminder");

    expect(preview.envelopes).toBe(0);
    expect(listForEnvelope).not.toHaveBeenCalled();
  });

  it("still considers one whose expiry is ahead, and one with none", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000);
    const { service, listForEnvelope } = makeService([
      envelope({ id: 7, expiresAt: tomorrow }),
      envelope({ id: 8, expiresAt: null }),
    ]);

    await service.previewSweep(ORG, "reminder");

    /* Both reached the recipient read; whether either sends depends on its recipients, not its expiry. */
    expect(listForEnvelope).toHaveBeenCalledTimes(2);
  });
});

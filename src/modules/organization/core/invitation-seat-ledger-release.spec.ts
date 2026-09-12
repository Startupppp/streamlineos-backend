import { InvitationLifecycleService } from "./invitation-lifecycle.service";

const ORG_ID = "org-ledger-1";

function buildRevokeTx(rows: Array<{ id: string }>) {
  const returning = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  const values = jest.fn().mockResolvedValue(undefined);
  const insert = jest.fn().mockReturnValue({ values });
  const execute = jest.fn().mockResolvedValue([]);
  return { update, insert, execute, values, returning };
}

function buildLifecycleService(recordSeatEvents: jest.Mock) {
  const db = {
    query: {
      invitations: { findFirst: jest.fn().mockResolvedValue(undefined) },
      organizations: { findFirst: jest.fn().mockResolvedValue(null) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      users: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    transaction: jest.fn(),
  };
  return new InvitationLifecycleService(
    db as never,
    { log: jest.fn() } as never,
    { invalidateForOrg: jest.fn().mockResolvedValue(undefined) } as never,
    { sendInvitationRevokedEmail: jest.fn().mockResolvedValue(undefined) } as never,
    { assertWithinLimit: jest.fn() } as never,
    { recordSeatEvents, recordSeatEvent: jest.fn() } as never,
    { canManageOrganizationMembership: jest.fn().mockResolvedValue(true) } as never,
  );
}

describe("revokeAllPending releases every reserved seat it revokes", () => {
  it("emits one INVITE_CANCELLED per revoked invitation", async () => {
    const recordSeatEvents = jest.fn().mockResolvedValue(undefined);
    const tx = buildRevokeTx([{ id: "inv-a" }, { id: "inv-b" }, { id: "inv-c" }]);
    const service = buildLifecycleService(recordSeatEvents);

    const revoked = await service.revokeAllPending(ORG_ID, tx as never);

    expect(revoked).toBe(3);
    expect(recordSeatEvents).toHaveBeenCalledTimes(1);

    const [txArg, orgArg, events] = recordSeatEvents.mock.calls[0] as [
      unknown,
      string,
      Array<{ eventType: string; subjectId: string; idempotencyKey: string }>,
    ];
    expect(txArg).toBe(tx);
    expect(orgArg).toBe(ORG_ID);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.eventType)).toEqual([
      "INVITE_CANCELLED",
      "INVITE_CANCELLED",
      "INVITE_CANCELLED",
    ]);
    expect(events.map((e) => e.subjectId)).toEqual(["inv-a", "inv-b", "inv-c"]);
    expect(events.map((e) => e.idempotencyKey)).toEqual([
      "invite-cancelled:inv-a",
      "invite-cancelled:inv-b",
      "invite-cancelled:inv-c",
    ]);
  });

  it("records the release on the same transaction that performed the revoke", async () => {
    const recordSeatEvents = jest.fn().mockResolvedValue(undefined);
    const tx = buildRevokeTx([{ id: "inv-a" }]);
    const service = buildLifecycleService(recordSeatEvents);

    await service.revokeAllPending(ORG_ID, tx as never);

    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(recordSeatEvents.mock.calls[0]?.[0]).toBe(tx);
    expect(tx.returning.mock.invocationCallOrder[0]).toBeLessThan(
      recordSeatEvents.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("emits nothing when there was no pending invitation to revoke", async () => {
    const recordSeatEvents = jest.fn().mockResolvedValue(undefined);
    const tx = buildRevokeTx([]);
    const service = buildLifecycleService(recordSeatEvents);

    const revoked = await service.revokeAllPending(ORG_ID, tx as never);

    expect(revoked).toBe(0);
    expect(recordSeatEvents).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });
});

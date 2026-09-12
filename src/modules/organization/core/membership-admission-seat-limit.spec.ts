import { MembershipAdmissionService } from "./membership-admission.service";

function buildTx(cancelledRows: Array<{ id: string }> = []) {
  const updateReturning = jest.fn().mockResolvedValue(cancelledRows);
  const updateWhere = jest.fn().mockReturnValue({ returning: updateReturning });
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const update = jest.fn().mockReturnValue({ set: updateSet });
  const insert = jest.fn().mockReturnValue({
    values: jest.fn().mockResolvedValue([]),
  });
  const execute = jest.fn().mockResolvedValue([]);
  return { update, insert, execute, updateReturning, updateSet, updateWhere };
}

/**
 * Ported from `hr/directory/employee-onboarding-seat-limit.spec.ts`, which pinned the
 * same invariant on the hand-built advisory lock HR used to own. The lock now lives
 * here, so the assertion follows it: the quota lock is taken before the limit is read,
 * and both run on the transaction that performs the membership insert.
 */
describe("MembershipAdmissionService member-seat reservation", () => {
  it("locks the organization quota before checking the limit in the same transaction", async () => {
    const tx = buildTx();
    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const seatLedger = { recordSeatEvents: jest.fn().mockResolvedValue(undefined) };
    const membership = {
      createMemberships: jest.fn().mockResolvedValue(new Map([["user-1", 7]])),
    };
    const service = new MembershipAdmissionService(planLimits as never, seatLedger as never);

    const outcomes = await service.admitMany(tx as never, {
      orgId: "org-1",
      actor: { userId: "actor-1" },
      membership: membership as never,
      candidates: [
        {
          email: "joiner@example.com",
          role: "MEMBER",
          screen: { kind: "clear", userId: "user-1" },
          createUserIfMissing: null,
        },
      ],
    });

    expect(outcomes).toEqual([
      { kind: "admitted", userId: "user-1", membershipId: 7, createdUser: false },
    ]);
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(planLimits.assertWithinLimit).toHaveBeenCalledWith("org-1", "members", 1, tx);
    expect(tx.execute.mock.invocationCallOrder[0]).toBeLessThan(
      planLimits.assertWithinLimit.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("reserves the whole batch once rather than once per candidate", async () => {
    const tx = buildTx();
    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const seatLedger = { recordSeatEvents: jest.fn().mockResolvedValue(undefined) };
    const membership = {
      createMemberships: jest.fn().mockResolvedValue(
        new Map([
          ["user-1", 7],
          ["user-2", 8],
        ]),
      ),
    };
    const service = new MembershipAdmissionService(planLimits as never, seatLedger as never);

    await service.admitMany(tx as never, {
      orgId: "org-1",
      actor: { userId: "actor-1" },
      membership: membership as never,
      candidates: [
        {
          email: "one@example.com",
          role: "MEMBER",
          screen: { kind: "clear", userId: "user-1" },
          createUserIfMissing: null,
        },
        {
          email: "two@example.com",
          role: "MEMBER",
          screen: { kind: "clear", userId: "user-2" },
          createUserIfMissing: null,
        },
      ],
    });

    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(planLimits.assertWithinLimit).toHaveBeenCalledTimes(1);
    expect(planLimits.assertWithinLimit).toHaveBeenCalledWith("org-1", "members", 2, tx);
  });

  it("rejects later canonical-email duplicates while admitting the other rows", async () => {
    const tx = buildTx();
    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const seatLedger = { recordSeatEvents: jest.fn().mockResolvedValue(undefined) };
    const membership = {
      createMemberships: jest.fn().mockResolvedValue(new Map([["user-1", 7]])),
    };
    const service = new MembershipAdmissionService(planLimits as never, seatLedger as never);

    const outcomes = await service.admitMany(tx as never, {
      orgId: "org-1",
      actor: { userId: "actor-1" },
      membership: membership as never,
      candidates: [
        {
          email: "joiner@example.com",
          role: "MEMBER",
          screen: { kind: "clear", userId: "user-1" },
          createUserIfMissing: null,
        },
        {
          email: " JOINER@EXAMPLE.COM ",
          role: "MEMBER",
          screen: { kind: "clear", userId: "user-1" },
          createUserIfMissing: null,
        },
      ],
    });

    expect(outcomes).toEqual([
      { kind: "admitted", userId: "user-1", membershipId: 7, createdUser: false },
      {
        kind: "conflict",
        reason: "duplicate-in-batch",
        message: "Duplicate email in this upload",
      },
    ]);
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(planLimits.assertWithinLimit).toHaveBeenCalledWith("org-1", "members", 1, tx);
    expect(membership.createMemberships).toHaveBeenCalledWith(tx, {
      orgId: "org-1",
      members: [{ userId: "user-1", role: "MEMBER" }],
    });
  });

  it("never touches the quota when every candidate is refused", async () => {
    const tx = buildTx();
    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const seatLedger = { recordSeatEvents: jest.fn().mockResolvedValue(undefined) };
    const membership = { createMemberships: jest.fn() };
    const service = new MembershipAdmissionService(planLimits as never, seatLedger as never);

    const outcomes = await service.admitMany(tx as never, {
      orgId: "org-1",
      actor: { userId: "actor-1" },
      membership: membership as never,
      candidates: [
        {
          email: "member@example.com",
          role: "MEMBER",
          screen: {
            kind: "conflict",
            reason: "already-member",
            message: "User is already a member of this organization",
          },
          createUserIfMissing: null,
        },
      ],
    });

    expect(outcomes[0]).toMatchObject({ kind: "conflict", reason: "already-member" });
    expect(tx.execute).not.toHaveBeenCalled();
    expect(planLimits.assertWithinLimit).not.toHaveBeenCalled();
    expect(membership.createMemberships).not.toHaveBeenCalled();
  });
});

describe("MembershipAdmissionService.admitMany — pending-invitation cancellation (P7)", () => {
  it("cancels live pending invitations before asserting the seat limit", async () => {
    const cancelledRows = [{ id: "inv-pending-1" }];
    const tx = buildTx(cancelledRows);

    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const seatLedger = { recordSeatEvents: jest.fn().mockResolvedValue(undefined) };
    const membership = {
      createMemberships: jest.fn().mockResolvedValue(new Map([["user-1", 9]])),
    };
    const service = new MembershipAdmissionService(planLimits as never, seatLedger as never);

    await service.admitMany(tx as never, {
      orgId: "org-1",
      actor: { userId: "actor-1" },
      membership: membership as never,
      candidates: [
        {
          email: "joiner@example.com",
          role: "MEMBER",
          screen: { kind: "clear", userId: "user-1" },
          createUserIfMissing: null,
        },
      ],
    });

    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(seatLedger.recordSeatEvents).toHaveBeenCalledWith(
      tx,
      "org-1",
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "INVITE_CANCELLED",
          subjectId: "inv-pending-1",
          idempotencyKey: "invite-cancelled:inv-pending-1",
        }),
      ]),
    );

    expect(tx.update.mock.invocationCallOrder[0]).toBeLessThan(
      planLimits.assertWithinLimit.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("emits no INVITE_CANCELLED event when no pending invitations exist for the email", async () => {
    const tx = buildTx([]);

    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const seatLedger = { recordSeatEvents: jest.fn().mockResolvedValue(undefined) };
    const membership = {
      createMemberships: jest.fn().mockResolvedValue(new Map([["user-2", 10]])),
    };
    const service = new MembershipAdmissionService(planLimits as never, seatLedger as never);

    await service.admitMany(tx as never, {
      orgId: "org-1",
      actor: { userId: "actor-1" },
      membership: membership as never,
      candidates: [
        {
          email: "new@example.com",
          role: "MEMBER",
          screen: { kind: "clear", userId: "user-2" },
          createUserIfMissing: null,
        },
      ],
    });

    const cancelCalls = seatLedger.recordSeatEvents.mock.calls.filter((args) => {
      const events: Array<{ eventType: string }> = args[2] as never;
      return events.some((e) => e.eventType === "INVITE_CANCELLED");
    });
    expect(cancelCalls).toHaveLength(0);
  });

  it("cancels invitations for all cleared candidates in one update", async () => {
    const cancelledRows = [{ id: "inv-a" }, { id: "inv-b" }];
    const tx = buildTx(cancelledRows);

    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const seatLedger = { recordSeatEvents: jest.fn().mockResolvedValue(undefined) };
    const membership = {
      createMemberships: jest.fn().mockResolvedValue(
        new Map([
          ["user-a", 11],
          ["user-b", 12],
        ]),
      ),
    };
    const service = new MembershipAdmissionService(planLimits as never, seatLedger as never);

    await service.admitMany(tx as never, {
      orgId: "org-1",
      actor: { userId: "actor-1" },
      membership: membership as never,
      candidates: [
        {
          email: "alice@example.com",
          role: "MEMBER",
          screen: { kind: "clear", userId: "user-a" },
          createUserIfMissing: null,
        },
        {
          email: "bob@example.com",
          role: "MEMBER",
          screen: { kind: "clear", userId: "user-b" },
          createUserIfMissing: null,
        },
      ],
    });

    expect(tx.update).toHaveBeenCalledTimes(1);
    const cancelEvents = (
      seatLedger.recordSeatEvents.mock.calls.find((args) => {
        const events: Array<{ eventType: string }> = args[2] as never;
        return events.some((e) => e.eventType === "INVITE_CANCELLED");
      }) ?? []
    )[2] as Array<{ eventType: string; subjectId: string }>;
    expect(cancelEvents.map((e) => e.subjectId).sort()).toEqual(["inv-a", "inv-b"]);
  });
});

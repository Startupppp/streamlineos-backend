import { MembershipAdmissionService } from "./membership-admission.service";

/**
 * Ported from `hr/directory/employee-onboarding-seat-limit.spec.ts`, which pinned the
 * same invariant on the hand-built advisory lock HR used to own. The lock now lives
 * here, so the assertion follows it: the quota lock is taken before the limit is read,
 * and both run on the transaction that performs the membership insert.
 */
describe("MembershipAdmissionService member-seat reservation", () => {
  it("locks the organization quota before checking the limit in the same transaction", async () => {
    const tx = { execute: jest.fn().mockResolvedValue([]) };
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
    const tx = { execute: jest.fn().mockResolvedValue([]) };
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
    const tx = { execute: jest.fn().mockResolvedValue([]) };
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
    const tx = { execute: jest.fn().mockResolvedValue([]) };
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

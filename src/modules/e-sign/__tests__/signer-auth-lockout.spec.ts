import { ForbiddenException } from "@nestjs/common";
import { SignPublicService } from "../sign-public.service";

/**
 * The brute-force gate on a public signing link, which had no test at all.
 *
 * `authenticate` is reachable by anyone holding a signing URL, and an access
 * code is short. What stands between a guesser and a signature is five attempts
 * and a fifteen-minute lock — logic that lives in three places (`failedAuthAttempts`
 * incrementing on failure, `authLockedUntil` set at the threshold, both cleared
 * on success) and, before this file, was asserted nowhere. It reads correct
 * today; nothing stopped it regressing tomorrow.
 *
 * The case that carries the weight is the third: while locked, the CORRECT code
 * is still refused. A lock that lets the right answer through is not a lock, and
 * a test that only checks the wrong answer is refused would pass against one.
 */
const MAX = 5;

type SetPayload = Record<string, unknown>;

function serviceWith(recipient: Partial<Record<string, unknown>>) {
  const sets: SetPayload[] = [];

  const row = {
    id: 7,
    orgId: "org-1",
    envelopeId: 11,
    name: "Priya",
    email: "priya@example.invalid",
    status: "sent",
    authMethod: "access_code",
    accessCodeHash: "hash-of-correct",
    otpCodeHash: null,
    otpExpiresAt: null,
    failedAuthAttempts: 0,
    authLockedUntil: null,
    tokenRevokedAt: null,
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
    signingTokenHash: "hash-of-token",
    ...recipient,
  };

  const envelope = { id: 11, orgId: "org-1", status: "sent", title: "MSA" };

  const tx = {
    execute: jest.fn(async () => undefined),
    query: {
      signRecipients: { findFirst: jest.fn(async () => row) },
      signEnvelopes: { findFirst: jest.fn(async () => envelope) },
    },
  };

  const db = {
    transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    query: tx.query,
    update: jest.fn(() => ({
      set: (payload: SetPayload) => {
        sets.push(payload);
        return { where: jest.fn(async () => undefined) };
      },
    })),
  };

  /* `hash` is the identity here so "hash-of-correct" is the correct code. */
  const tokens = { hash: jest.fn((v: string) => `hash-of-${v}`) };
  const audit = { record: jest.fn(async () => undefined) };
  const noop = {} as never;

  /*
   * Eight, in the order the constructor declares them: db, storage, audit,
   * tokens, envelopes, finalization, notifications, integrations. My first
   * version passed ten — jest ran it happily, because ts-jest checks no types
   * here, and `tsc` rejected it. Second time tonight I have hand-built a class
   * with the wrong arity, and both times only the typecheck-run-last caught it.
   */
  const service = new SignPublicService(
    db as never,
    noop,
    audit as never,
    tokens as never,
    noop,
    noop,
    noop,
    noop,
  );

  return { service, sets, audit };
}

const ctx = { ipAddress: "1.2.3.4", userAgent: "jest" };

describe("the signer authentication lockout", () => {
  it("counts a wrong code without locking before the threshold", async () => {
    const { service, sets } = serviceWith({ failedAuthAttempts: 2 });

    await expect(
      service.authenticate("token", { accessCode: "wrong" }, ctx),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(sets[0]).toMatchObject({ failedAuthAttempts: 3, authLockedUntil: null });
  });

  it("locks for fifteen minutes on the fifth wrong code", async () => {
    const { service, sets } = serviceWith({ failedAuthAttempts: MAX - 1 });
    const before = Date.now();

    await expect(
      service.authenticate("token", { accessCode: "wrong" }, ctx),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(sets[0]?.failedAuthAttempts).toBe(MAX);
    const until = sets[0]?.authLockedUntil as Date;
    expect(until).toBeInstanceOf(Date);
    /* Fifteen minutes, allowing for the clock moving during the call. */
    expect(until.getTime() - before).toBeGreaterThanOrEqual(14 * 60_000);
    expect(until.getTime() - before).toBeLessThanOrEqual(16 * 60_000);
  });

  it("refuses the CORRECT code while the lock is in force", async () => {
    const { service, sets } = serviceWith({
      failedAuthAttempts: MAX,
      authLockedUntil: new Date(Date.now() + 5 * 60_000),
    });

    await expect(
      service.authenticate("token", { accessCode: "correct" }, ctx),
    ).rejects.toBeInstanceOf(ForbiddenException);

    /*
     * Nothing was written, which is the assertion with teeth. A lock that
     * merely returned a failure while still marking the recipient authenticated
     * would satisfy a test that only checked for a throw.
     */
    expect(sets).toEqual([]);
  });

  it("clears the count and the lock on a correct code", async () => {
    const { service, sets } = serviceWith({
      failedAuthAttempts: 3,
      authLockedUntil: new Date(Date.now() - 60_000),
    });

    await service.authenticate("token", { accessCode: "correct" }, ctx);

    expect(sets[0]).toMatchObject({
      status: "authenticated",
      failedAuthAttempts: 0,
      authLockedUntil: null,
    });
  });

  it("does not use otpAttempts as the counter, though the column suggests it", async () => {
    const { service, sets } = serviceWith({ failedAuthAttempts: 1 });

    await expect(
      service.authenticate("token", { accessCode: "wrong" }, ctx),
    ).rejects.toBeInstanceOf(ForbiddenException);

    /*
     * `otpAttempts` is written exactly once in this module — set to 0 by
     * `requestOtp` — and is never incremented or read. `failedAuthAttempts` is
     * the real counter. Pinned because a reader seeing `otpAttempts: 0` beside
     * an OTP would reasonably assume it counts OTP attempts, and a future check
     * written against it would gate on a number that never moves.
     */
    expect(sets[0]).not.toHaveProperty("otpAttempts");
  });
});

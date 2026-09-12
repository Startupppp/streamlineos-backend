jest.mock("../../../common/tenant/with-public-token", () => ({
  withPublicToken: <T>(db: unknown, _token: string, fn: (tx: unknown) => Promise<T>) => fn(db),
}));

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: <T>(db: unknown, fn: (tx: unknown) => Promise<T>) => fn(db),
}));

import { ForbiddenException } from "@nestjs/common";
import { SignPublicService } from "../sign-public.service";

/**
 * SIGN-P1-08 — lockout parity between `otp_email` and `otp_sms`.
 *
 * `authenticate` (sign-public.service.ts) verifies both one-time-code channels
 * in **one** branch, so the attempt counter and the 15-minute lockout apply to
 * `otp_sms` by construction. That is the correct design and this spec is not
 * arguing with it.
 *
 * What was missing is a test that *names* `otp_sms` and lockout together. Every
 * existing assertion about the counter runs through `otp_email`, so the day
 * someone splits the shared branch — to add an SMS-specific expiry, a resend
 * budget, a carrier error path — `otp_sms` can quietly lose the lockout and the
 * whole suite stays green. An SMS channel with no lockout is an unmetered
 * brute-force oracle against a six-digit code, and it also costs real money per
 * guess.
 *
 * So this pins the property through the SMS path specifically, at both places a
 * split could break it:
 *   1. the counter/lock **write** — attempt 5 on `otp_sms` must set
 *      `authLockedUntil`, and
 *   2. the lock **pre-check** — a locked `otp_sms` recipient must be refused
 *      even when they finally present the right code,
 * and then asserts the `otp_sms` threshold equals the `otp_email` threshold
 * rather than hard-coding 5 in two places.
 */

type Method = "otp_email" | "otp_sms";

const CORRECT_OTP = "123456";
const WRONG_OTP = "000000";

/** Generous ceiling: high enough that a *removed* lockout is visible as "never locked". */
const ATTEMPT_CEILING = 12;

function buildHarness(authMethod: Method) {
  const recipient: Record<string, unknown> = {
    id: 7,
    orgId: "org_1",
    envelopeId: 10,
    name: "Signer Person",
    email: "signer@example.com",
    phone: "+15550100",
    status: "viewed",
    authMethod,
    /** The service hashes the submitted code with `tokens.hash`, stubbed below. */
    otpCodeHash: `hash:${CORRECT_OTP}`,
    otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    otpAttempts: 0,
    failedAuthAttempts: 0,
    authLockedUntil: null,
    authenticatedAt: null,
    consentAcceptedAt: null,
    tokenRevokedAt: null,
    tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  };

  const envelope = {
    id: 10,
    orgId: "org_1",
    status: "sent",
    title: "Lockout parity envelope",
    /** The sender is a membership (`sign_envelopes.sender_membership_id`); `authenticate` never reads it. */
    senderMembershipId: 1,
  };

  const patches: Record<string, unknown>[] = [];
  const auditEvents: string[] = [];

  const db = {
    query: {
      /** A fresh copy each read, exactly as a real re-read of the row would be. */
      signRecipients: { findFirst: async () => ({ ...recipient }) },
      signEnvelopes: { findFirst: async () => envelope },
    },
    /** `authenticate` re-reads the row under `FOR UPDATE`; the same fresh copy. */
    // Mirrors the real chain: .where().limit(1).for('update').
    select: () => ({ from: () => ({ where: () => ({ limit: () => ({ for: async () => [{ ...recipient }] }) }) }) }),
    /** Writes land back on `recipient`, so the counter accumulates across calls. */
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          patches.push(patch);
          Object.assign(recipient, patch);
        },
      }),
    }),
  };

  const service = new SignPublicService(
    db as never,
    {} as never, // storage
    {
      record: async (e: { eventType: string }) => {
        auditEvents.push(e.eventType);
      },
    } as never, // audit
    { hash: (v: string) => `hash:${v}` } as never, // tokens
    {} as never, // envelopes
    { sendOtpCode: async () => undefined } as never, // notifications
    {} as never, // integrations
    { isConfigured: () => true, send: async () => undefined } as never, // sms
  );

  return { service, recipient, patches, auditEvents };
}

const CTX = { ipAddress: "203.0.113.9", userAgent: "jest" };

/**
 * Submits wrong codes until the row locks. Returns the 1-based attempt number
 * on which `authLockedUntil` was first set, or `null` if it never locked within
 * the ceiling — which is precisely the failure a split branch would produce.
 */
async function attemptsUntilLocked(authMethod: Method) {
  const h = buildHarness(authMethod);
  let lockedOnAttempt: number | null = null;

  for (let attempt = 1; attempt <= ATTEMPT_CEILING; attempt++) {
    await expect(
      h.service.authenticate("tok", { otpCode: WRONG_OTP } as never, CTX),
    ).rejects.toBeInstanceOf(ForbiddenException);

    if (lockedOnAttempt === null && h.recipient.authLockedUntil instanceof Date) {
      lockedOnAttempt = attempt;
      break;
    }
  }

  return { ...h, lockedOnAttempt };
}

describe("SIGN-P1-08 · otp_sms lockout parity with otp_email", () => {
  it("locks an otp_sms recipient out after the shared threshold of failed codes", async () => {
    const { lockedOnAttempt, recipient } = await attemptsUntilLocked("otp_sms");

    expect(lockedOnAttempt).toBe(5);
    expect(recipient.failedAuthAttempts).toBe(5);
    expect(recipient.authLockedUntil).toBeInstanceOf(Date);
  });

  it("does not lock an otp_sms recipient early", async () => {
    /**
     * Parity cuts both ways: a stricter SMS branch is drift too, and it would
     * strand a signer whose carrier delivered the code late.
     */
    const h = buildHarness("otp_sms");

    for (let attempt = 1; attempt <= 4; attempt++) {
      await expect(
        h.service.authenticate("tok", { otpCode: WRONG_OTP } as never, CTX),
      ).rejects.toThrow("Authentication failed");
      expect(h.recipient.authLockedUntil).toBeNull();
    }

    expect(h.recipient.failedAuthAttempts).toBe(4);
  });

  it("gives otp_sms the same 15-minute lockout window as the shared branch mints", async () => {
    const before = Date.now();
    const { recipient } = await attemptsUntilLocked("otp_sms");
    const lockedUntil = recipient.authLockedUntil as Date;

    const windowMs = lockedUntil.getTime() - before;
    expect(windowMs).toBeGreaterThan(14 * 60 * 1000);
    expect(windowMs).toBeLessThanOrEqual(15 * 60 * 1000 + 5_000);
  });

  it("refuses a locked-out otp_sms recipient even when they present the CORRECT code", async () => {
    /**
     * This is the half a split branch is most likely to drop: the pre-check at
     * the top of `authenticate` is method-agnostic today, and an SMS-specific
     * fast path would step straight over it. Without this assertion, moving the
     * lock check inside the `otp_email` arm would still leave the counter
     * incrementing — the lock row would be written and then never read, which
     * looks correct in the database and is worthless in practice.
     */
    const { service, recipient } = await attemptsUntilLocked("otp_sms");
    expect(recipient.authLockedUntil).toBeInstanceOf(Date);

    await expect(
      service.authenticate("tok", { otpCode: CORRECT_OTP } as never, CTX),
    ).rejects.toThrow("Too many failed attempts");

    /** Still refused, so no authentication happened. */
    expect(recipient.authenticatedAt).toBeNull();
    expect(recipient.status).toBe("viewed");
  });

  it("records an authentication_failed audit event on the otp_sms path too", async () => {
    const h = buildHarness("otp_sms");

    await expect(
      h.service.authenticate("tok", { otpCode: WRONG_OTP } as never, CTX),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(h.auditEvents).toEqual(["authentication_failed"]);
  });

  it("clears the otp_sms counter on a successful code, like otp_email", async () => {
    const h = buildHarness("otp_sms");

    await expect(
      h.service.authenticate("tok", { otpCode: WRONG_OTP } as never, CTX),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.recipient.failedAuthAttempts).toBe(1);

    await expect(
      h.service.authenticate("tok", { otpCode: CORRECT_OTP } as never, CTX),
    ).resolves.toEqual({ authenticated: true });

    expect(h.recipient.failedAuthAttempts).toBe(0);
    expect(h.recipient.authLockedUntil).toBeNull();
    expect(h.recipient.status).toBe("authenticated");
  });

  it("locks otp_sms on exactly the same attempt count as otp_email", async () => {
    /**
     * The parity assertion proper — derived from both channels rather than
     * restating the constant, so raising `MAX_AUTH_ATTEMPTS` keeps this green
     * while splitting the branch does not.
     */
    const sms = await attemptsUntilLocked("otp_sms");
    const email = await attemptsUntilLocked("otp_email");

    expect(sms.lockedOnAttempt).not.toBeNull();
    expect(email.lockedOnAttempt).not.toBeNull();
    expect(sms.lockedOnAttempt).toBe(email.lockedOnAttempt);
  });

  it("refuses a locked otp_email recipient identically, so the pre-check parity is pinned from both sides", async () => {
    const { service } = await attemptsUntilLocked("otp_email");

    await expect(
      service.authenticate("tok", { otpCode: CORRECT_OTP } as never, CTX),
    ).rejects.toThrow("Too many failed attempts");
  });
});

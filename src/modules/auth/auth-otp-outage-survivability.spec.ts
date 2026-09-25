import { ServiceUnavailableException } from "@nestjs/common";
import { logger } from "../../common/logger/logger.service";
import {
  createEmail,
  createWorld,
  makeService,
  EMAIL,
} from "./auth-email-otp-claim.spec-fixtures";

/**
 * HRMS-E2E-023. QA's member waited ~20 minutes, received seven codes at once,
 * pressed Resend, and was then told a valid-looking code was rejected.
 *
 * The batching is the provider's and belongs to ops. What is ours is the
 * ordering underneath it. `requestEmailOtp` retired every prior unused code
 * *before* attempting the send, so:
 *
 *   1. A person holding a delivered code in their inbox lost it the moment they
 *      pressed Resend — which is exactly what a person does when a code is slow.
 *   2. When the send then failed, the catch retired the new code too, leaving
 *      them with no usable code at all while the UI said one had been sent.
 *
 * Sending first and retiring only on success inverts that: a failed send leaves
 * the person exactly as they were. The window where two codes are live is safe
 * because `verifyEmailOtp` reads the newest unused row and only that one —
 * which `auth-email-otp-claim.spec.ts` already pins as
 * "CORRECT-BY-DESIGN: with two live codes only the newest is accepted".
 *
 * BE-84 forbids the network call inside a transaction, so this is an ordering,
 * not a wrapping transaction.
 */
describe("a failed send leaves the person able to sign in", () => {
  it("keeps the earlier code alive when the provider refuses the new one", async () => {
    const world = createWorld();
    const prior = world.seed({ code: "111111" });
    const email = createEmail({ fails: true });
    const spy = jest.spyOn(logger, "error").mockImplementation(() => undefined);

    try {
      await expect(
        makeService(world, email.service).requestEmailOtp(EMAIL),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      spy.mockRestore();
    }

    // The code already in their inbox is the only one they have. Burning it on
    // our way out strands them until the provider recovers.
    expect(prior.usedAt).toBeNull();
  });

  it("still burns the code it could not deliver", async () => {
    // The paired assertion. Surviving the outage must not mean an undelivered
    // code stays live — nobody has it, and it would outrank the next one.
    const world = createWorld();
    world.seed({ code: "111111" });
    const email = createEmail({ fails: true });
    const spy = jest.spyOn(logger, "error").mockImplementation(() => undefined);

    try {
      await expect(
        makeService(world, email.service).requestEmailOtp(EMAIL),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      spy.mockRestore();
    }

    const undelivered = world.rows.at(-1);
    expect(undelivered?.usedAt).not.toBeNull();
  });

  it("retires the earlier code once the new one is actually delivered", async () => {
    // The whole point of retiring at all, and the property the ordering must not
    // lose: after a successful resend the older code no longer works.
    const world = createWorld();
    const prior = world.seed({ code: "111111" });
    const email = createEmail();

    await makeService(world, email.service).requestEmailOtp(EMAIL);

    expect(prior.usedAt).not.toBeNull();
    expect(email.sendEmailOtpEmail).toHaveBeenCalledTimes(1);
  });

  it("sends before it retires, so nothing is lost to a send that never happens", async () => {
    const world = createWorld();
    world.seed({ code: "111111" });
    const email = createEmail();

    await makeService(world, email.service).requestEmailOtp(EMAIL);

    const insert = world.operations.indexOf("insert-otp");
    const invalidate = world.operations.lastIndexOf("invalidate");
    expect(insert).toBeGreaterThanOrEqual(0);
    expect(invalidate).toBeGreaterThan(insert);
  });
});

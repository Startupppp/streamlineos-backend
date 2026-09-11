/**
 * AuthEmailOtpService operates on global identity tables (users, email_otp_codes,
 * magic_link_tokens). Cross-user isolation: OTP verification always looks up by
 * email → userId, then filters OTP codes by that userId — user A cannot claim user
 * B's OTP because the code row is matched by userId from the DB, never from the client.
 *
 * This spec verifies that an attempt to verify an OTP for a user with no pending code
 * returns an Unauthorized error rather than a success — the no-rows case simulates the
 * predicate filtering out another user's tokens.
 */

import { UnauthorizedException } from "@nestjs/common";
import { AuthEmailOtpService } from "./auth-email-otp.service";
import type { Db } from "../../db/drizzle.module";

function makeDb(userRow: unknown, otpRow: unknown): Db {
  return {
    query: {
      users: { findFirst: jest.fn().mockResolvedValue(userRow) },
      emailOtpCodes: { findFirst: jest.fn().mockResolvedValue(otpRow) },
    },
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  } as unknown as Db;
}

describe("AuthEmailOtpService — cross-user isolation", () => {
  it("rejects OTP verification when no active code exists for the queried user (cross-user isolation)", async () => {
    const db = makeDb(
      { id: "user-attacker", isActive: true, deletedAt: null },
      null,
    );
    const svc = new AuthEmailOtpService(db, {} as never);

    await expect(
      svc.verifyEmailOtp("attacker@example.com", "123456"),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("rejects OTP verification when the user account does not exist", async () => {
    const db = makeDb(null, null);
    const svc = new AuthEmailOtpService(db, {} as never);

    await expect(
      svc.verifyEmailOtp("nobody@example.com", "123456"),
    ).rejects.toThrow(UnauthorizedException);
  });
});

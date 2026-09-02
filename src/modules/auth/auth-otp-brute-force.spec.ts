import { UnauthorizedException } from "@nestjs/common";
import { AuthPasswordlessService } from "./auth-passwordless.service";
import { hashToken } from "../../common/security/token.util";
import type { Db } from "../../db/drizzle.module";

const USER = { id: "user-1", isActive: true, deletedAt: null };
const CODE = "482931";
const VALID_CODE_HASH = hashToken(CODE);

const OTP_ROW = {
  id: "otp-1",
  userId: "user-1",
  codeHash: VALID_CODE_HASH,
  expiresAt: new Date(Date.now() + 300_000),
  usedAt: null,
  attempts: 0,
  createdAt: new Date(),
};

function buildDb(bumpedAttempts: number | null, succeeds: boolean): Db {
  let updateCallIdx = 0;

  const update = jest.fn().mockImplementation(() => {
    const callIdx = ++updateCallIdx;
    const whereFn = jest.fn().mockImplementation(() => {
      if (callIdx === 1) {
        const rows =
          bumpedAttempts === null ? [] : [{ attempts: bumpedAttempts }];
        return { returning: jest.fn().mockResolvedValue(rows) };
      }
      if (callIdx === 2)
        return { returning: jest.fn().mockResolvedValue([{ id: "otp-1" }]) };
      return { returning: jest.fn().mockResolvedValue([]) };
    });
    return { set: jest.fn().mockReturnValue({ where: whereFn }) };
  });

  const insert = jest.fn().mockReturnValue({
    values: jest.fn().mockResolvedValue(undefined),
  });

  return {
    query: {
      users: {
        findFirst: jest.fn().mockResolvedValue(succeeds ? USER : null),
      },
      emailOtpCodes: {
        findFirst: jest.fn().mockResolvedValue(OTP_ROW),
      },
    },
    update,
    insert,
  } as unknown as Db;
}

function makeService(db: Db): AuthPasswordlessService {
  return new AuthPasswordlessService(
    db,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe("AuthPasswordlessService.verifyEmailOtp — brute-force lockout bite proofs", () => {
  it("BITE: 6th attempt triggers lockout → UnauthorizedException before timing-safe check", async () => {
    const db = buildDb(6, true);
    const svc = makeService(db);
    await expect(svc.verifyEmailOtp("user@example.com", CODE)).rejects.toThrow(
      UnauthorizedException,
    );
    const [, markUsed] = (db.update as jest.Mock).mock.results;
    expect(markUsed).toBeUndefined();
  });

  it("NEUTER: 4th attempt → lockout does not fire; valid code succeeds and returns autoLoginToken", async () => {
    const db = buildDb(4, true);
    const svc = makeService(db);
    const result = await svc.verifyEmailOtp("user@example.com", CODE);
    expect(result).toHaveProperty("autoLoginToken");
    expect(typeof result.autoLoginToken).toBe("string");
    expect(result.autoLoginToken.length).toBeGreaterThan(0);
  });

  it("lockout fires for null bumped row (concurrent invalidation wins) → UnauthorizedException", async () => {
    const db = buildDb(null, true);
    const svc = makeService(db);
    await expect(svc.verifyEmailOtp("user@example.com", CODE)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("unknown user returns generic error — no account enumeration", async () => {
    const db = buildDb(4, false);
    const svc = makeService(db);
    await expect(svc.verifyEmailOtp("nobody@example.com", CODE)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("attempt counter is bumped atomically before the code check — bump is always recorded even on wrong code", async () => {
    const wrongCode = "000000";
    const db = buildDb(3, true);
    const svc = makeService(db);
    await expect(svc.verifyEmailOtp("user@example.com", wrongCode)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});

/**
 * Findings register #23 / #242 — the three INTERNAL_API_SECRET routes on
 * auth.controller.ts.
 *
 * `POST auth/google`, `POST auth/session-exchange` and
 * `GET auth/session-data/:userId` were the only @Public() routes on this
 * controller that called no `enforceRateLimit`, so a leaked shared secret minted
 * sessions and harvested session data with no limiter at all. The secret compare
 * was also a plain `!==` on the raw strings, which leaks both the bytes and the
 * length through timing.
 *
 * These specs assert the limiter is reached on every one of the three, that a
 * 429 stops the call before the downstream service runs, and that the compare
 * goes through the fixed-width digest helper rather than `!==`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { SignJWT } from "jose";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthTokensService } from "./auth-tokens.service";
import { internalSecretMatches } from "./internal-secret";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { JwtKeyringService } from "../../common/auth/jwt-keyring.service";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { MembershipStateService } from "../../common/auth/membership-state.service";
import { REDIS } from "../../common/cache/cache.service";
import { SESSION_PROOF_ISSUER, SESSION_PROOF_AUDIENCE } from "../../common/auth/backend-claims";

const NEXTAUTH_SECRET = "test-nextauth-secret-at-least-32-chars-long-xxx";
const INTERNAL_SECRET = "test-internal-secret-at-least-32-chars-long-xx";
const USER_ID = "user-1";
const SESSION_ID = "session-1";

const secretHeaders = () => ({ "x-internal-secret": INTERNAL_SECRET }) as Record<string, string>;

async function makeProof(): Promise<string> {
  return new SignJWT({ sessionId: SESSION_ID })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(USER_ID)
    .setIssuer(SESSION_PROOF_ISSUER)
    .setAudience(SESSION_PROOF_AUDIENCE)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime("30s")
    .sign(new TextEncoder().encode(NEXTAUTH_SECRET));
}

describe("internalSecretMatches — constant-time over a fixed-width digest", () => {
  it("accepts the configured secret", () => {
    expect(internalSecretMatches(INTERNAL_SECRET, INTERNAL_SECRET)).toBe(true);
  });

  it("rejects a different secret of the same length", () => {
    const wrong = `${INTERNAL_SECRET.slice(0, -1)}z`;
    expect(internalSecretMatches(INTERNAL_SECRET, wrong)).toBe(false);
  });

  it("rejects a shorter and a longer presentation without throwing on the length mismatch", () => {
    expect(internalSecretMatches(INTERNAL_SECRET, "x")).toBe(false);
    expect(internalSecretMatches(INTERNAL_SECRET, `${INTERNAL_SECRET}extra`)).toBe(false);
  });

  it("rejects when the server has no secret configured, even against an empty presentation", () => {
    expect(internalSecretMatches(undefined, "")).toBe(false);
    expect(internalSecretMatches("", "")).toBe(false);
    expect(internalSecretMatches(undefined, undefined)).toBe(false);
  });

  it("rejects a non-string header value", () => {
    expect(internalSecretMatches(INTERNAL_SECRET, ["a", "b"])).toBe(false);
  });

  it("leaves no raw `!==` compare against INTERNAL_API_SECRET in the controller", () => {
    const source = readFileSync(join(__dirname, "auth.controller.ts"), "utf8");
    expect(source).not.toMatch(/!==\s*(internalSecret|secret)\b/);
    expect(source).toContain("internalSecretMatches(");
  });
});

describe("AuthController — the INTERNAL_API_SECRET routes enforce a rate limit", () => {
  let controller: AuthController;
  let rateLimit: { check: jest.Mock };
  let authService: { getSessionData: jest.Mock };
  let authTokens: { googleOAuth: jest.Mock };
  let keyring: { isReady: jest.Mock; signToken: jest.Mock };

  const originalNextAuth = process.env.NEXTAUTH_SECRET;
  const originalInternal = process.env.INTERNAL_API_SECRET;

  beforeEach(async () => {
    process.env.NEXTAUTH_SECRET = NEXTAUTH_SECRET;
    process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;

    rateLimit = { check: jest.fn().mockResolvedValue({ allowed: true, retryAfterSecs: 0 }) };
    authService = { getSessionData: jest.fn().mockResolvedValue({ userId: USER_ID }) };
    authTokens = { googleOAuth: jest.fn().mockResolvedValue({ token: "t" }) };
    keyring = { isReady: jest.fn().mockReturnValue(true), signToken: jest.fn().mockResolvedValue("signed.jwt") };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: AuthTokensService, useValue: authTokens },
        { provide: RateLimitService, useValue: rateLimit },
        { provide: JwtKeyringService, useValue: keyring },
        {
          provide: MembershipStateService,
          useValue: {
            isAccountActive: jest.fn().mockResolvedValue(true),
            resolve: jest.fn().mockResolvedValue({ active: true, membershipId: 1 }),
          },
        },
        { provide: REDIS, useValue: { set: jest.fn().mockResolvedValue("OK"), get: jest.fn().mockResolvedValue(null) } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(AuthController);
  });

  afterEach(() => {
    process.env.NEXTAUTH_SECRET = originalNextAuth;
    process.env.INTERNAL_API_SECRET = originalInternal;
  });

  it("GET auth/session-data/:userId limits on the subject user", async () => {
    await controller.getSessionData(USER_ID, { headers: secretHeaders() });
    expect(rateLimit.check).toHaveBeenCalledWith("auth:session-data", USER_ID);
  });

  it("GET auth/session-data/:userId returns 429 and never reads the session when the limit is exhausted", async () => {
    rateLimit.check.mockResolvedValue({ allowed: false, retryAfterSecs: 30 });
    await expect(
      controller.getSessionData(USER_ID, { headers: secretHeaders() }),
    ).rejects.toMatchObject({ status: 429 });
    expect(authService.getSessionData).not.toHaveBeenCalled();
  });

  it("POST auth/google limits on the signing-in email", async () => {
    await controller.googleOAuth(
      { email: "Person@Example.com", googleId: "g-1" },
      { headers: secretHeaders() },
    );
    expect(rateLimit.check).toHaveBeenCalledWith("auth:google", "person@example.com");
  });

  it("POST auth/google returns 429 and never mints a session when the limit is exhausted", async () => {
    rateLimit.check.mockResolvedValue({ allowed: false, retryAfterSecs: 30 });
    await expect(
      controller.googleOAuth({ email: "p@example.com", googleId: "g-1" }, { headers: secretHeaders() }),
    ).rejects.toMatchObject({ status: 429 });
    expect(authTokens.googleOAuth).not.toHaveBeenCalled();
  });

  it("POST auth/session-exchange limits on the proof subject", async () => {
    const proof = await makeProof();
    await controller.sessionExchange({ orgId: null }, { headers: { ...secretHeaders(), "x-session-proof": proof } });
    expect(rateLimit.check).toHaveBeenCalledWith("auth:session-exchange", USER_ID);
  });

  it("POST auth/session-exchange returns 429 and never signs a token when the limit is exhausted", async () => {
    rateLimit.check.mockResolvedValue({ allowed: false, retryAfterSecs: 30 });
    const proof = await makeProof();
    await expect(
      controller.sessionExchange({ orgId: null }, { headers: { ...secretHeaders(), "x-session-proof": proof } }),
    ).rejects.toMatchObject({ status: 429 });
    expect(keyring.signToken).not.toHaveBeenCalled();
  });

  it("still refuses a wrong secret with 403 before it reaches the limiter", async () => {
    await expect(
      controller.getSessionData(USER_ID, { headers: { "x-internal-secret": "wrong" } }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(rateLimit.check).not.toHaveBeenCalled();
  });
});

describe("rate-limit tiers are declared — an unknown tier denies, so a missing entry is an outage", () => {
  it("declares a tier for each of the three routes", async () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "common", "ratelimit", "rate-limit.service.ts"),
      "utf8",
    );
    for (const tier of ["auth:google", "auth:session-exchange", "auth:session-data"])
      expect(source).toContain(`"${tier}": { limit:`);
  });
});

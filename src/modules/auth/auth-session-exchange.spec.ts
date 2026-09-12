import { Test, TestingModule } from "@nestjs/testing";
import { HttpException, HttpStatus } from "@nestjs/common";
import { SignJWT, exportJWK } from "jose";
import { generateKeyPairSync } from "node:crypto";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthEmailVerificationService } from "./auth-email-verification.service";
import { AuthMagicLinkService } from "./auth-magic-link.service";
import { AuthEmailOtpService } from "./auth-email-otp.service";
import { AuthAnalyticsService } from "./auth-analytics.service";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { JwtKeyringService } from "../../common/auth/jwt-keyring.service";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { MembershipStateService } from "../../common/auth/membership-state.service";
import { REDIS } from "../../common/cache/cache.service";
import { SESSION_PROOF_ISSUER, SESSION_PROOF_AUDIENCE } from "../../common/auth/backend-claims";
import { DRIZZLE } from "../../db/drizzle.constants";

const NEXTAUTH_SECRET = "test-nextauth-secret-at-least-32-chars-long-xxx";
const INTERNAL_SECRET = "test-internal-secret-at-least-32-chars-long-xx";

async function makeProof(
  userId: string,
  sessionId: string,
  overrides: {
    secret?: string;
    issuer?: string;
    audience?: string;
    expiry?: string;
    jti?: string;
  } = {},
): Promise<string> {
  const nonce = overrides.jti ?? crypto.randomUUID();
  return new SignJWT({ sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(overrides.issuer ?? SESSION_PROOF_ISSUER)
    .setAudience(overrides.audience ?? SESSION_PROOF_AUDIENCE)
    .setJti(nonce)
    .setIssuedAt()
    .setExpirationTime(overrides.expiry ?? "30s")
    .sign(new TextEncoder().encode(overrides.secret ?? NEXTAUTH_SECRET));
}

function makeDbStub(sessionRow: { isRevoked: boolean; expiresAt: Date | null } | null, throws = false) {
  const select = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: throws
          ? jest.fn().mockRejectedValue(new Error("db unavailable"))
          : jest.fn().mockResolvedValue(sessionRow ? [sessionRow] : []),
      }),
    }),
  });
  return { select };
}

describe("AuthController — session-exchange endpoint", () => {
  let controller: AuthController;
  let keyring: jest.Mocked<JwtKeyringService>;
  let membershipState: jest.Mocked<MembershipStateService>;
  let redis: { set: jest.Mock; get: jest.Mock };
  let db: ReturnType<typeof makeDbStub>;

  const originalNextAuth = process.env.NEXTAUTH_SECRET;
  const originalInternal = process.env.INTERNAL_API_SECRET;

  beforeEach(async () => {
    process.env.NEXTAUTH_SECRET = NEXTAUTH_SECRET;
    process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;

    redis = { set: jest.fn(), get: jest.fn() };
    redis.set.mockResolvedValue("OK");
    redis.get.mockResolvedValue(null);

    db = makeDbStub({ isRevoked: false, expiresAt: null });

    keyring = {
      isReady: jest.fn().mockReturnValue(true),
      signToken: jest.fn().mockResolvedValue("signed.backend.jwt"),
    } as unknown as jest.Mocked<JwtKeyringService>;

    membershipState = {
      isAccountActive: jest.fn().mockResolvedValue(true),
      resolve: jest.fn().mockResolvedValue({ active: true, membershipId: "mem_1", role: "MEMBER", isOwner: false }),
    } as unknown as jest.Mocked<MembershipStateService>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: AuthEmailVerificationService, useValue: {} },
        { provide: AuthMagicLinkService, useValue: {} },
        { provide: AuthEmailOtpService, useValue: {} },
        { provide: AuthAnalyticsService, useValue: {} },
        { provide: RateLimitService, useValue: { check: jest.fn().mockResolvedValue({ allowed: true }) } },
        { provide: JwtKeyringService, useValue: keyring },
        { provide: MembershipStateService, useValue: membershipState },
        { provide: REDIS, useValue: redis },
        { provide: DRIZZLE, useValue: db },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .compile();

    controller = module.get(AuthController);
  });

  afterEach(() => {
    process.env.NEXTAUTH_SECRET = originalNextAuth;
    process.env.INTERNAL_API_SECRET = originalInternal;
    jest.clearAllMocks();
  });

  it("accepts a valid session proof and mints a backend JWT", async () => {
    const proof = await makeProof("user-1", "sess-1");
    const req = { headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof } };
    const result = await controller.sessionExchange({ orgId: "org-1" }, req as never);
    expect(result).toEqual({ token: "signed.backend.jwt" });
    expect(keyring.signToken).toHaveBeenCalledWith({ sub: "user-1", orgId: "org-1", sessionId: "sess-1" });
  });

  it("denies when x-internal-secret is absent", async () => {
    const req = { headers: {} };
    await expect(controller.sessionExchange({ orgId: null }, req as never)).rejects.toThrow(
      new HttpException("Forbidden", HttpStatus.FORBIDDEN),
    );
  });

  it("denies when x-session-proof is absent", async () => {
    const req = { headers: { "x-internal-secret": INTERNAL_SECRET } };
    await expect(controller.sessionExchange({ orgId: null }, req as never)).rejects.toThrow(
      new HttpException("Forbidden", HttpStatus.FORBIDDEN),
    );
  });

  it("denies when session proof is signed with the wrong secret", async () => {
    const proof = await makeProof("user-1", "sess-1", { secret: "wrong-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    const req = { headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof } };
    await expect(controller.sessionExchange({ orgId: null }, req as never)).rejects.toThrow(
      new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED),
    );
  });

  it("denies an expired session proof", async () => {
    const nonce = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const proof = await new SignJWT({ sessionId: "sess-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setIssuer(SESSION_PROOF_ISSUER)
      .setAudience(SESSION_PROOF_AUDIENCE)
      .setJti(nonce)
      .setIssuedAt(now - 120)
      .setExpirationTime(now - 60)
      .sign(new TextEncoder().encode(NEXTAUTH_SECRET));
    const req = { headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof } };
    await expect(controller.sessionExchange({ orgId: null }, req as never)).rejects.toThrow(
      new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED),
    );
  });

  it("denies a replayed proof (same nonce used twice)", async () => {
    const nonce = crypto.randomUUID();
    const proof = await makeProof("user-1", "sess-1", { jti: nonce });
    const req = { headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof } };

    // First call succeeds — nonce is fresh
    await controller.sessionExchange({ orgId: null }, req as never);

    // Second call must be rejected — nonce is replayed
    redis.set.mockResolvedValue(null);
    await expect(controller.sessionExchange({ orgId: null }, req as never)).rejects.toThrow(
      new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED),
    );
  });

  it("denies when the session is revoked via Redis tombstone", async () => {
    redis.get.mockResolvedValue(true);
    const proof = await makeProof("user-1", "sess-1");
    const req = { headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof } };
    await expect(controller.sessionExchange({ orgId: null }, req as never)).rejects.toThrow(
      new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED),
    );
  });

  it("denies when the session is revoked in the DB and Redis is absent (the bite)", async () => {
    const revokedDb = makeDbStub({ isRevoked: true, expiresAt: null });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: AuthEmailVerificationService, useValue: {} },
        { provide: AuthMagicLinkService, useValue: {} },
        { provide: AuthEmailOtpService, useValue: {} },
        { provide: AuthAnalyticsService, useValue: {} },
        { provide: RateLimitService, useValue: { check: jest.fn().mockResolvedValue({ allowed: true }) } },
        { provide: JwtKeyringService, useValue: keyring },
        { provide: MembershipStateService, useValue: membershipState },
        { provide: REDIS, useValue: null },
        { provide: DRIZZLE, useValue: revokedDb },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .compile();
    const ctrlNoRedis = module.get(AuthController);
    const proof = await makeProof("user-1", "sess-1");
    const req = { headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof } };
    await expect(ctrlNoRedis.sessionExchange({ orgId: null }, req as never)).rejects.toThrow(
      new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED),
    );
    expect(revokedDb.select).toHaveBeenCalled();
  });

  it("denies when Redis tombstone is absent but DB shows session row is missing (fail-closed at mint boundary)", async () => {
    const missingDb = makeDbStub(null);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: AuthEmailVerificationService, useValue: {} },
        { provide: AuthMagicLinkService, useValue: {} },
        { provide: AuthEmailOtpService, useValue: {} },
        { provide: AuthAnalyticsService, useValue: {} },
        { provide: RateLimitService, useValue: { check: jest.fn().mockResolvedValue({ allowed: true }) } },
        { provide: JwtKeyringService, useValue: keyring },
        { provide: MembershipStateService, useValue: membershipState },
        { provide: REDIS, useValue: null },
        { provide: DRIZZLE, useValue: missingDb },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .compile();
    const ctrlNoRedis = module.get(AuthController);
    const proof = await makeProof("user-1", "sess-1");
    const req = { headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof } };
    await expect(ctrlNoRedis.sessionExchange({ orgId: null }, req as never)).rejects.toThrow(
      new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED),
    );
  });

  it("denies when Redis tombstone is absent but DB shows session is expired", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const expiredDb = makeDbStub({ isRevoked: false, expiresAt: yesterday });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: AuthEmailVerificationService, useValue: {} },
        { provide: AuthMagicLinkService, useValue: {} },
        { provide: AuthEmailOtpService, useValue: {} },
        { provide: AuthAnalyticsService, useValue: {} },
        { provide: RateLimitService, useValue: { check: jest.fn().mockResolvedValue({ allowed: true }) } },
        { provide: JwtKeyringService, useValue: keyring },
        { provide: MembershipStateService, useValue: membershipState },
        { provide: REDIS, useValue: null },
        { provide: DRIZZLE, useValue: expiredDb },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .compile();
    const ctrlNoRedis = module.get(AuthController);
    const proof = await makeProof("user-1", "sess-1");
    const req = { headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof } };
    await expect(ctrlNoRedis.sessionExchange({ orgId: null }, req as never)).rejects.toThrow(
      new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED),
    );
  });

  it("denies when Redis throws (error path) and DB shows session is revoked", async () => {
    redis.get.mockRejectedValue(new Error("redis connection refused"));
    db = makeDbStub({ isRevoked: true, expiresAt: null });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: AuthEmailVerificationService, useValue: {} },
        { provide: AuthMagicLinkService, useValue: {} },
        { provide: AuthEmailOtpService, useValue: {} },
        { provide: AuthAnalyticsService, useValue: {} },
        { provide: RateLimitService, useValue: { check: jest.fn().mockResolvedValue({ allowed: true }) } },
        { provide: JwtKeyringService, useValue: keyring },
        { provide: MembershipStateService, useValue: membershipState },
        { provide: REDIS, useValue: redis },
        { provide: DRIZZLE, useValue: db },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .compile();
    const ctrlWithThrowingRedis = module.get(AuthController);
    const proof = await makeProof("user-1", "sess-1");
    const req = { headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof } };
    await expect(ctrlWithThrowingRedis.sessionExchange({ orgId: null }, req as never)).rejects.toThrow(
      new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED),
    );
    expect(db.select).toHaveBeenCalled();
  });

  it("denies when Redis is present, the tombstone is a cache MISS, and the DB says the session is revoked", async () => {
    redis.get.mockResolvedValue(null);
    const revokedDb = makeDbStub({ isRevoked: true, expiresAt: null });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: AuthEmailVerificationService, useValue: {} },
        { provide: AuthMagicLinkService, useValue: {} },
        { provide: AuthEmailOtpService, useValue: {} },
        { provide: AuthAnalyticsService, useValue: {} },
        { provide: RateLimitService, useValue: { check: jest.fn().mockResolvedValue({ allowed: true }) } },
        { provide: JwtKeyringService, useValue: keyring },
        { provide: MembershipStateService, useValue: membershipState },
        { provide: REDIS, useValue: redis },
        { provide: DRIZZLE, useValue: revokedDb },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .compile();
    const ctrlCacheMiss = module.get(AuthController);
    const proof = await makeProof("user-1", "sess-1");
    const req = { headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof } };
    await expect(ctrlCacheMiss.sessionExchange({ orgId: null }, req as never)).rejects.toThrow(
      new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED),
    );
    expect(revokedDb.select).toHaveBeenCalled();
    expect(keyring.signToken).not.toHaveBeenCalled();
  });

  it("NEUTER: Redis present, tombstone a cache MISS, DB says live — the session still mints", async () => {
    redis.get.mockResolvedValue(null);
    const proof = await makeProof("user-1", "sess-1");
    const req = { headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof } };
    const result = await controller.sessionExchange({ orgId: "org-1" }, req as never);
    expect(result).toEqual({ token: "signed.backend.jwt" });
    expect(db.select).toHaveBeenCalled();
  });

  it("denies when the session proof names a different userId than any body field would imply", async () => {
    const proof = await makeProof("actual-user", "sess-1");
    const req = { headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof } };
    // Body contains no userId — identity must come from the verified proof only
    const result = await controller.sessionExchange({ orgId: "org-1" }, req as never);
    // Verify the minted token uses the userId from the PROOF, not from any body field
    expect(keyring.signToken).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "actual-user" }),
    );
    expect(result.token).toBeTruthy();
  });

  it("denies when INTERNAL_API_SECRET alone is sent without a session proof", async () => {
    const req = { headers: { "x-internal-secret": INTERNAL_SECRET } };
    await expect(controller.sessionExchange({ orgId: null }, req as never)).rejects.toThrow(
      new HttpException("Forbidden", HttpStatus.FORBIDDEN),
    );
  });

  it("denies when proof has wrong issuer", async () => {
    const proof = await makeProof("user-1", "sess-1", { issuer: "evil-issuer" });
    const req = { headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof } };
    await expect(controller.sessionExchange({ orgId: null }, req as never)).rejects.toThrow(
      new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED),
    );
  });

  it("denies when proof has wrong audience", async () => {
    const proof = await makeProof("user-1", "sess-1", { audience: "wrong-audience" });
    const req = { headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof } };
    await expect(controller.sessionExchange({ orgId: null }, req as never)).rejects.toThrow(
      new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED),
    );
  });

  it("denies when the account is inactive", async () => {
    membershipState.isAccountActive.mockResolvedValue(false);
    const proof = await makeProof("user-1", "sess-1");
    const req = { headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof } };
    await expect(controller.sessionExchange({ orgId: null }, req as never)).rejects.toThrow(
      new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED),
    );
  });

  it("denies when org membership is inactive", async () => {
    membershipState.resolve.mockResolvedValue({ active: false, membershipId: null, role: "", isOwner: false });
    const proof = await makeProof("user-1", "sess-1");
    const req = { headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof } };
    await expect(controller.sessionExchange({ orgId: "org-1" }, req as never)).rejects.toThrow(
      new HttpException("Forbidden", HttpStatus.FORBIDDEN),
    );
  });

  it("an EdDSA-signed token used as a proof is rejected (wrong algorithm)", async () => {
    const kp = generateKeyPairSync("ed25519");
    const privJwk = await exportJWK(kp.privateKey as unknown as CryptoKey);
    const { importJWK } = await import("jose");
    const privateKey = await importJWK(privJwk, "EdDSA");

    const badProof = await new SignJWT({ sessionId: "sess-1" })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject("user-1")
      .setIssuer(SESSION_PROOF_ISSUER)
      .setAudience(SESSION_PROOF_AUDIENCE)
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(privateKey);

    const req = { headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": badProof } };
    await expect(controller.sessionExchange({ orgId: null }, req as never)).rejects.toThrow(
      new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED),
    );
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HttpException, HttpStatus, UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import { SignJWT, decodeJwt, exportJWK, generateKeyPair } from "jose";
import { randomUUID } from "node:crypto";
import { AuthController } from "../../../src/modules/auth/auth.controller";
import { AuthService } from "../../../src/modules/auth/auth.service";
import { sessionExchangeSchema } from "../../../src/modules/auth/dto/auth.schemas";
import { AuthEmailVerificationService } from "../../../src/modules/auth/auth-email-verification.service";
import { AuthMagicLinkService } from "../../../src/modules/auth/auth-magic-link.service";
import { AuthEmailOtpService } from "../../../src/modules/auth/auth-email-otp.service";
import { AuthAnalyticsService } from "../../../src/modules/auth/auth-analytics.service";
import { RateLimitService } from "../../../src/common/ratelimit/rate-limit.service";
import { JwtKeyringService } from "../../../src/common/auth/jwt-keyring.service";
import { JwtAuthGuard } from "../../../src/common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../src/modules/access/permission.guard";
import { MembershipStateService } from "../../../src/common/auth/membership-state.service";
import { REDIS } from "../../../src/common/cache/cache.service";
import {
  SESSION_PROOF_AUDIENCE,
  SESSION_PROOF_ISSUER,
} from "../../../src/common/auth/backend-claims";
import { hashToken } from "../../../src/common/security/token.util";
import {
  expiredByTimePredicate,
  openAdminInvitationFilter,
} from "../../../src/modules/organization/core/invitations.helpers";
import { emailOtpCodes, magicLinkTokens, users } from "../../../src/db/schema";
import type { Db } from "../../../src/db/drizzle.module";

const BACKEND_ROOT = resolve(__dirname, "../../..");
const NEXTAUTH_SECRET = "appsec-nextauth-secret-at-least-32-chars-long";
const INTERNAL_SECRET = "appsec-internal-secret-at-least-32-chars-long";

async function makeProof(
  userId: string,
  sessionId: string,
  jti: string = randomUUID(),
): Promise<string> {
  return new SignJWT({ sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(SESSION_PROOF_ISSUER)
    .setAudience(SESSION_PROOF_AUDIENCE)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime("30s")
    .sign(new TextEncoder().encode(NEXTAUTH_SECRET));
}

async function realKeyring(): Promise<JwtKeyringService> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  const previous = process.env.AUTH_SIGNING_KEYS;
  process.env.AUTH_SIGNING_KEYS = JSON.stringify([
    { kid: "appsec-kid", privateKey: await exportJWK(privateKey), publicKey: await exportJWK(publicKey) },
  ]);
  const keyring = new JwtKeyringService();
  await keyring.onModuleInit();
  if (previous === undefined) delete process.env.AUTH_SIGNING_KEYS;
  else process.env.AUTH_SIGNING_KEYS = previous;
  return keyring;
}

describe("Session fixation — the minted token's identity comes from the signed proof", () => {
  let controller: AuthController;
  let keyring: JwtKeyringService;
  let membershipState: { isAccountActive: jest.Mock; resolve: jest.Mock };
  let redis: { get: jest.Mock; set: jest.Mock };

  const originalNextAuth = process.env.NEXTAUTH_SECRET;
  const originalInternal = process.env.INTERNAL_API_SECRET;

  beforeEach(async () => {
    process.env.NEXTAUTH_SECRET = NEXTAUTH_SECRET;
    process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;

    keyring = await realKeyring();
    redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue("OK") };
    membershipState = {
      isAccountActive: jest.fn().mockResolvedValue(true),
      resolve: jest
        .fn()
        .mockResolvedValue({ active: true, membershipId: 3, role: "MEMBER", isOwner: false }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: AuthEmailVerificationService, useValue: {} },
        { provide: AuthMagicLinkService, useValue: {} },
        { provide: AuthEmailOtpService, useValue: {} },
        { provide: AuthAnalyticsService, useValue: {} },
        {
          provide: RateLimitService,
          useValue: { check: jest.fn().mockResolvedValue({ allowed: true, retryAfterSecs: 0 }) },
        },
        { provide: JwtKeyringService, useValue: keyring },
        { provide: MembershipStateService, useValue: membershipState },
        { provide: REDIS, useValue: redis },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(AuthController);
  });

  afterEach(() => {
    process.env.NEXTAUTH_SECRET = originalNextAuth;
    process.env.INTERNAL_API_SECRET = originalInternal;
  });

  it("the issued token carries the proof's subject and session id", async () => {
    const proof = await makeProof("user-real", "sess-real");
    const { token } = await controller.sessionExchange({ orgId: "org-1" }, {
      headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof },
    } as never);

    const claims = decodeJwt(token);
    expect(claims.sub).toBe("user-real");
    expect(claims["sessionId"]).toBe("sess-real");
    expect(claims["orgId"]).toBe("org-1");
  });

  it("the exchange body is strict and cannot carry a session or a user id to fix", () => {
    for (const hostile of [
      { orgId: "org-1", sessionId: "attacker-chosen" },
      { orgId: "org-1", userId: "victim" },
      { orgId: "org-1", sub: "victim" },
      { sessionId: "attacker-chosen" },
    ]) {
      expect({ hostile, ok: sessionExchangeSchema.safeParse(hostile).success }).toEqual({
        hostile,
        ok: false,
      });
    }
    expect(sessionExchangeSchema.safeParse({ orgId: "org-1" }).success).toBe(true);
  });

  it("a stale token cannot be re-minted for a session whose membership is gone", async () => {
    membershipState.resolve.mockResolvedValue({
      active: false,
      membershipId: null,
      role: "MEMBER",
      isOwner: false,
    });
    const proof = await makeProof("user-real", "sess-real");
    const error = await controller
      .sessionExchange({ orgId: "org-1" }, {
        headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof },
      } as never)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(HttpStatus.FORBIDDEN);
  });

  it("a revoked session cannot be exchanged for a fresh token", async () => {
    redis.get.mockResolvedValue(true);
    const proof = await makeProof("user-real", "sess-revoked");
    const error = await controller
      .sessionExchange({ orgId: "org-1" }, {
        headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof },
      } as never)
      .catch((err: unknown) => err);

    expect((error as HttpException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  });
});

describe("Session replay — a captured proof is spendable exactly once", () => {
  let controller: AuthController;
  let redisStore: Map<string, unknown>;

  const originalNextAuth = process.env.NEXTAUTH_SECRET;
  const originalInternal = process.env.INTERNAL_API_SECRET;

  beforeEach(async () => {
    process.env.NEXTAUTH_SECRET = NEXTAUTH_SECRET;
    process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;
    redisStore = new Map();

    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn((key: string, value: unknown, opts?: { nx?: boolean }) => {
        if (opts?.nx === true && redisStore.has(key)) return Promise.resolve(null);
        redisStore.set(key, value);
        return Promise.resolve("OK");
      }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: AuthEmailVerificationService, useValue: {} },
        { provide: AuthMagicLinkService, useValue: {} },
        { provide: AuthEmailOtpService, useValue: {} },
        { provide: AuthAnalyticsService, useValue: {} },
        {
          provide: RateLimitService,
          useValue: { check: jest.fn().mockResolvedValue({ allowed: true, retryAfterSecs: 0 }) },
        },
        { provide: JwtKeyringService, useValue: await realKeyring() },
        {
          provide: MembershipStateService,
          useValue: {
            isAccountActive: jest.fn().mockResolvedValue(true),
            resolve: jest
              .fn()
              .mockResolvedValue({ active: true, membershipId: 3, role: "MEMBER", isOwner: false }),
          },
        },
        { provide: REDIS, useValue: redis },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(AuthController);
  });

  afterEach(() => {
    process.env.NEXTAUTH_SECRET = originalNextAuth;
    process.env.INTERNAL_API_SECRET = originalInternal;
  });

  function exchange(proof: string): Promise<{ token: string }> {
    return controller.sessionExchange({ orgId: "org-1" }, {
      headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof },
    } as never);
  }

  it("replaying the identical proof is refused the second time", async () => {
    const proof = await makeProof("user-1", "sess-1", "nonce-fixed");
    await expect(exchange(proof)).resolves.toHaveProperty("token");
    await expect(exchange(proof)).rejects.toThrow(HttpException);
  });

  it("a freshly signed proof that reuses a spent nonce is also refused", async () => {
    const first = await makeProof("user-1", "sess-1", "nonce-shared");
    await exchange(first);

    const forged = await makeProof("user-1", "sess-2", "nonce-shared");
    const error = await exchange(forged).catch((err: unknown) => err);
    expect((error as HttpException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  });

  it("CONTROL: a distinct nonce from the same session still works, so the refusal is about replay", async () => {
    await expect(exchange(await makeProof("user-1", "sess-1"))).resolves.toHaveProperty("token");
    await expect(exchange(await makeProof("user-1", "sess-1"))).resolves.toHaveProperty("token");
  });
});

interface MagicLinkRow {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
}

function passwordlessDb(options: {
  magicLink?: MagicLinkRow;
  user?: { id: string; isActive: boolean; deletedAt: Date | null } | null;
}) {
  const inserted: Array<Record<string, unknown>> = [];
  const row = options.magicLink;

  const db = {
    inserted,
    query: {
      magicLinkTokens: { findFirst: () => Promise.resolve(row) },
      users: { findFirst: () => Promise.resolve(options.user ?? null) },
      emailOtpCodes: { findFirst: () => Promise.resolve(undefined) },
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        const apply = (): unknown[] => {
          if (table === magicLinkTokens && row) {
            if (row.usedAt !== null) return [];
            row.usedAt = values.usedAt as Date;
            return [{ id: row.id }];
          }
          return [];
        };
        const chain = {
          where: () => {
            const rows = apply();
            return Object.assign(Promise.resolve(rows), {
              returning: () => Promise.resolve(rows),
            });
          },
        };
        return chain;
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserted.push({ table, ...values });
        return Promise.resolve([]);
      },
    }),
  };
  void users;
  void emailOtpCodes;
  return db;
}

function passwordlessService(db: ReturnType<typeof passwordlessDb>): AuthMagicLinkService {
  return new AuthMagicLinkService(
    db as unknown as Db,
    { invalidate: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    {
      resolvePreferredOrgId: jest.fn().mockResolvedValue("org-1"),
      resolveActiveMembership: jest.fn().mockResolvedValue({ orgId: "org-1" }),
      createLoginSession: jest.fn().mockResolvedValue("sess-new"),
    } as never,
    { logLoginEvent: jest.fn().mockResolvedValue(undefined) } as never,
  );
}

describe("Magic link — a one-time credential, stored only as a hash", () => {
  const RAW = "0123456789abcdef".repeat(4);

  function liveRow(): MagicLinkRow {
    return {
      id: "ml-1",
      userId: "user-1",
      tokenHash: hashToken(RAW),
      expiresAt: new Date(Date.now() + 600_000),
      usedAt: null,
    };
  }

  it("the first redemption succeeds and the replay is refused", async () => {
    const db = passwordlessDb({
      magicLink: liveRow(),
      user: { id: "user-1", isActive: true, deletedAt: null },
    });
    const service = passwordlessService(db);

    await expect(service.verifyMagicLink(RAW, {})).resolves.toMatchObject({ userId: "user-1" });
    await expect(service.verifyMagicLink(RAW, {})).rejects.toThrow(UnauthorizedException);
  });

  it("the replay and the expiry are refused with the identical message — no oracle", async () => {
    const used = passwordlessDb({
      magicLink: { ...liveRow(), usedAt: new Date() },
      user: { id: "user-1", isActive: true, deletedAt: null },
    });
    const expired = passwordlessDb({
      magicLink: { ...liveRow(), expiresAt: new Date(Date.now() - 1000) },
      user: { id: "user-1", isActive: true, deletedAt: null },
    });

    const usedError = await passwordlessService(used)
      .verifyMagicLink(RAW, {})
      .catch((err: unknown) => err);
    const expiredError = await passwordlessService(expired)
      .verifyMagicLink(RAW, {})
      .catch((err: unknown) => err);

    expect((usedError as UnauthorizedException).getResponse()).toEqual(
      (expiredError as UnauthorizedException).getResponse(),
    );
  });

  it("an unknown token is refused without revealing that no such link exists", async () => {
    const db = passwordlessDb({ magicLink: undefined, user: null });
    const error = await passwordlessService(db)
      .verifyMagicLink("does-not-exist", {})
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getResponse()).toMatchObject({
      code: "AUTH_TOKEN_INVALID",
    });
  });

  it("a deactivated account is refused with the same generic invalid-credentials shape", async () => {
    const db = passwordlessDb({
      magicLink: liveRow(),
      user: { id: "user-1", isActive: false, deletedAt: null },
    });
    const error = await passwordlessService(db)
      .verifyMagicLink(RAW, {})
      .catch((err: unknown) => err);

    expect((error as UnauthorizedException).getResponse()).toMatchObject({
      code: "AUTH_TOKEN_INVALID",
    });
  });

  it("the credential is never persisted in the clear — only its sha256 digest is", () => {
    const digest = hashToken(RAW);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(RAW);
    expect(hashToken(RAW)).toBe(digest);
    expect(hashToken(`${RAW}x`)).not.toBe(digest);

    const service = readFileSync(
      resolve(BACKEND_ROOT, "src/modules/auth/auth-magic-link.service.ts"),
      "utf8",
    );
    expect(service).toMatch(/const tokenHash = hashToken\(/);
    expect(service).toMatch(/tokenHash,\r?\n/);
    expect(service).not.toMatch(/values\(\{[^}]*\btoken:\s*(?:rawToken|token)\b/);
  });
});

describe("Generic authentication failures are indistinguishable", () => {
  const CODE = "482931";

  function otpDb(options: {
    user: { id: string; isActive: boolean; deletedAt: Date | null } | null;
    otp?: { id: string; codeHash: string; usedAt: Date | null; attempts: number };
  }) {
    return {
      query: {
        users: { findFirst: () => Promise.resolve(options.user) },
        emailOtpCodes: { findFirst: () => Promise.resolve(options.otp) },
      },
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () =>
              Promise.resolve(options.otp ? [{ attempts: options.otp.attempts + 1 }] : []),
          }),
        }),
      }),
      insert: () => ({ values: () => Promise.resolve([]) }),
    } as unknown as Db;
  }

  async function failure(db: Db, code: string): Promise<{ status: number; body: unknown }> {
    const service = new AuthEmailOtpService(db, {} as never);
    const error = await service
      .verifyEmailOtp("someone@example.com", code)
      .catch((err: unknown) => err);
    const http = error as HttpException;
    return { status: http.getStatus(), body: http.getResponse() };
  }

  it("unknown user, wrong code, no live code and a disabled account all answer identically", async () => {
    const liveOtp = { id: "otp-1", codeHash: hashToken(CODE), usedAt: null, attempts: 0 };

    const responses = await Promise.all([
      failure(otpDb({ user: null }), CODE),
      failure(
        otpDb({ user: { id: "u1", isActive: true, deletedAt: null }, otp: liveOtp }),
        "000000",
      ),
      failure(otpDb({ user: { id: "u1", isActive: true, deletedAt: null } }), CODE),
      failure(
        otpDb({ user: { id: "u1", isActive: false, deletedAt: null }, otp: liveOtp }),
        CODE,
      ),
      failure(
        otpDb({ user: { id: "u1", isActive: true, deletedAt: new Date() }, otp: liveOtp }),
        CODE,
      ),
    ]);

    const distinct = new Set(responses.map((response) => JSON.stringify(response)));
    expect([...distinct]).toHaveLength(1);
    expect(responses[0]?.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it("BITE: a genuinely different failure would be caught by the comparison above", async () => {
    const liveOtp = { id: "otp-1", codeHash: hashToken(CODE), usedAt: null, attempts: 0 };
    const wrongCode = await failure(
      otpDb({ user: { id: "u1", isActive: true, deletedAt: null }, otp: liveOtp }),
      "000000",
    );
    expect(JSON.stringify(wrongCode)).not.toBe(
      JSON.stringify({ status: 404, body: "No account for that address" }),
    );
    expect(JSON.stringify(wrongCode)).toContain("Invalid or expired code");
  });

  it("registration with an already-registered address answers exactly as a fresh one does", () => {
    const source = readFileSync(
      resolve(BACKEND_ROOT, "src/modules/auth/auth.service.ts"),
      "utf8",
    );
    // The existing-address branch may finish a registration whose provisioning threw halfway
    // (resumeProvisioning), but it still answers `{ success: true }` and nothing else, the resume
    // is a no-op for an open account, and it has no refusal of its own that could become the oracle.
    expect(source).toMatch(
      /if \(existing\) \{\s*await this\.resumeProvisioning\(existing\);\s*return \{ success: true \};\s*\}/,
    );
    const resume = source.slice(
      source.indexOf("private async resumeProvisioning("),
      source.indexOf("async logout("),
    );
    expect(resume).toContain("if (existing.isActive) return;");
    expect(resume).not.toMatch(/\bthrow\b/);
    expect(source).not.toMatch(/ConflictException\(["'`][^"'`]*already/i);
  });

  it("resend-verification answers the same whether or not the address exists", () => {
    const controller = readFileSync(
      resolve(BACKEND_ROOT, "src/modules/auth/auth.controller.ts"),
      "utf8",
    );
    expect(controller).toContain("If an account exists, a verification email has been sent");

    const service = readFileSync(
      resolve(BACKEND_ROOT, "src/modules/auth/auth-email-verification.service.ts"),
      "utf8",
    );
    expect(service).toMatch(/if \(!user\) return;/);
  });
});

describe("Invitations — one-time, hashed, and never revived by id alone", () => {
  const dialect = new PgDialect();

  it("the token is stored as a digest the invitation link cannot be recovered from", () => {
    const raw = "invite-token-abcdef0123456789";
    const digest = hashToken(raw);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(raw);

    const service = readFileSync(
      resolve(BACKEND_ROOT, "src/modules/organization/core/invitation-acceptance.service.ts"),
      "utf8",
    );
    expect(service).toMatch(/const tokenHash = hashToken\(input\.token\);/);
  });

  it("the admin-side filter pins status and acceptance, so an id-only update cannot revive an accepted invite", () => {
    const { sql: text, params } = dialect.sqlToQuery(
      openAdminInvitationFilter("inv-1", "org-1")!,
    );
    expect(text).toContain('"status" = ');
    expect(text).toContain('"accepted_at" is null');
    expect(params).toEqual(["inv-1", "org-1", "PENDING"]);
  });

  it("the expiry sweep filter also requires PENDING and unaccepted, never expiry alone", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const { sql: text, params } = dialect.sqlToQuery(expiredByTimePredicate(now)!);
    expect(text).toContain('"status" = ');
    expect(text).toContain('"accepted_at" is null');
    expect(text).toContain('"expires_at" < ');
    expect(params).toEqual(["PENDING", now.toISOString()]);
  });

  it("acceptance looks the token up only among pending, unexpired, unaccepted invitations", () => {
    const service = readFileSync(
      resolve(BACKEND_ROOT, "src/modules/organization/core/invitation-acceptance.service.ts"),
      "utf8",
    );
    const lookup = service.slice(
      service.indexOf("private findPendingByToken"),
      service.indexOf("async accept("),
    );
    expect(lookup).toContain("eq(invitations.tokenHash, tokenHash)");
    expect(lookup).toContain('eq(invitations.status, "PENDING")');
    expect(lookup).toContain("gt(invitations.expiresAt, new Date())");
    expect(lookup).toContain("isNull(invitations.acceptedAt)");
  });

  it("the claim is a conditional update whose affected-row count is checked", () => {
    // The acceptance write half moved to lib/invitation-join.ts (cf0043c2e); the claim lives there.
    const join = readFileSync(
      resolve(BACKEND_ROOT, "src/modules/organization/core/lib/invitation-join.ts"),
      "utf8",
    );
    const claim = join.slice(
      join.indexOf("async function claimInvitation("),
      join.indexOf("function issueMagicLink("),
    );
    expect(claim).toContain('eq(invitations.status, "PENDING")');
    expect(claim).toContain("isNull(invitations.acceptedAt)");
    expect(claim).toContain("if (claimedRows.length === 0)");
    expect(claim).toContain("Invalid or expired invitation");
  });
});

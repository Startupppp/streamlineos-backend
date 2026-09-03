import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Redis } from "@upstash/redis";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { SESSION_PROOF_AUDIENCE, SESSION_PROOF_ISSUER } from "../../../src/common/auth/backend-claims";
import { JwtAuthGuard } from "../../../src/common/auth/jwt-auth.guard";
import { JwtKeyringService } from "../../../src/common/auth/jwt-keyring.service";
import { MembershipStateService } from "../../../src/common/auth/membership-state.service";
import { REDIS } from "../../../src/common/cache/cache.service";
import { redact } from "../../../src/common/observability/redact";
import { RateLimitService } from "../../../src/common/ratelimit/rate-limit.service";
import { validateEnv } from "../../../src/config/env.validation";
import { PermissionGuard } from "../../../src/modules/access/permission.guard";
import { AuthController } from "../../../src/modules/auth/auth.controller";
import { AuthService } from "../../../src/modules/auth/auth.service";
import { AuthTokensService } from "../../../src/modules/auth/auth-tokens.service";
import { internalSecretMatches } from "../../../src/modules/auth/internal-secret";
import type { Db } from "../../../src/db/drizzle.module";

const BACKEND_ROOT = resolve(__dirname, "../../..");
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"] as const;

function walkSource(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSource(full, out);
    else if (full.endsWith(".ts") && !full.endsWith("spec.ts") && !full.endsWith(".d.ts"))
      out.push(full);
  }
  return out;
}

const SOURCE_FILES = walkSource(resolve(BACKEND_ROOT, "src")).map((file) => ({
  path: relative(BACKEND_ROOT, file),
  content: readFileSync(file, "utf8"),
}));

interface KeyMaterial {
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
}

async function makeKeyMaterial(kid: string): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  return {
    kid,
    privateJwk: await exportJWK(privateKey),
    publicJwk: await exportJWK(publicKey),
  };
}

async function keyringFrom(
  entries: Array<{ kid: string; privateKey: JWK; publicKey: JWK }>,
): Promise<JwtKeyringService> {
  const previous = process.env.AUTH_SIGNING_KEYS;
  process.env.AUTH_SIGNING_KEYS = JSON.stringify(entries);
  const keyring = new JwtKeyringService();
  await keyring.onModuleInit();
  if (previous === undefined) delete process.env.AUTH_SIGNING_KEYS;
  else process.env.AUTH_SIGNING_KEYS = previous;
  return keyring;
}

function entryFor(material: KeyMaterial): { kid: string; privateKey: JWK; publicKey: JWK } {
  return { kid: material.kid, privateKey: material.privateJwk, publicKey: material.publicJwk };
}

function guardFor(keyring: JwtKeyringService, authorization: string): {
  guard: JwtAuthGuard;
  context: ExecutionContext;
} {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
  const emptyChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    const self = (): Record<string, unknown> => chain;
    chain.from = self;
    chain.where = self;
    chain.limit = self;
    chain.orderBy = self;
    chain.then = (onOk: (value: unknown) => unknown, onErr?: (reason: unknown) => unknown) =>
      Promise.resolve([]).then(onOk, onErr);
    return chain;
  };
  const db = { select: emptyChain } as unknown as Db;
  const membership = {
    isAccountActive: jest.fn().mockResolvedValue(true),
    resolve: jest
      .fn()
      .mockResolvedValue({ active: true, membershipId: 1, role: "MEMBER", isOwner: false }),
  } as unknown as MembershipStateService;
  const redis = { get: jest.fn().mockResolvedValue(null) } as unknown as Redis;

  const req = {
    headers: authorization === "" ? {} : { authorization },
    path: "/api/protected",
    url: "/api/protected",
    method: "GET",
  };
  return {
    guard: new JwtAuthGuard(reflector, db, redis, membership, keyring),
    context: {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext,
  };
}

describe("The published JWKS carries no private key material", () => {
  it("a correctly configured ring publishes only the public members", async () => {
    const material = await makeKeyMaterial("kid-1");
    const jwks = (await keyringFrom([entryFor(material)])).getJwks();

    expect(jwks.keys).toHaveLength(1);
    for (const key of jwks.keys) {
      for (const member of PRIVATE_JWK_MEMBERS) {
        expect({ member, present: key[member] !== undefined }).toEqual({ member, present: false });
      }
      expect(key.kid).toBe("kid-1");
      expect(key.use).toBe("sig");
      expect(key.x).toBe(material.publicJwk.x);
    }
  });

  it("REGRESSION: a private JWK misplaced into the publicKey slot is not published", async () => {
    const material = await makeKeyMaterial("kid-misconfigured");
    expect(material.privateJwk.d).toBeDefined();

    const keyring = await keyringFrom([
      { kid: material.kid, privateKey: material.privateJwk, publicKey: material.privateJwk },
    ]);
    const jwks = keyring.getJwks();
    const serialized = JSON.stringify(jwks);

    expect(jwks.keys[0]?.d).toBeUndefined();
    expect(serialized).not.toContain(String(material.privateJwk.d));
    expect(jwks.keys[0]?.x).toBe(material.publicJwk.x);
  });

  it("no key in a multi-key ring leaks its seed", async () => {
    const [first, second] = await Promise.all([
      makeKeyMaterial("kid-old"),
      makeKeyMaterial("kid-new"),
    ]);
    const keyring = await keyringFrom([entryFor(first), entryFor(second)]);
    const serialized = JSON.stringify(keyring.getJwks());

    expect(serialized).not.toContain(String(first.privateJwk.d));
    expect(serialized).not.toContain(String(second.privateJwk.d));
  });

  it("the service never spreads a raw exported JWK into the published document", () => {
    const source = readFileSync(
      resolve(BACKEND_ROOT, "src/common/auth/jwt-keyring.service.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/\.\.\.rawPublicJwk/);
    expect(source).toMatch(/PUBLIC_JWK_MEMBERS/);
  });
});

describe("Signing key rotation is enforced where the token is checked", () => {
  it("a token minted under the previous key still authenticates after a new key is added", async () => {
    const [first, second] = await Promise.all([
      makeKeyMaterial("kid-old"),
      makeKeyMaterial("kid-new"),
    ]);

    const before = await keyringFrom([entryFor(first)]);
    const legacyToken = await before.signToken({
      sub: "user-1",
      orgId: "org-1",
      sessionId: "sess-1",
    });

    const rotated = await keyringFrom([entryFor(first), entryFor(second)]);
    const { guard, context } = guardFor(rotated, `Bearer ${legacyToken}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("once the old key is retired, its tokens stop authenticating", async () => {
    const [first, second] = await Promise.all([
      makeKeyMaterial("kid-old"),
      makeKeyMaterial("kid-new"),
    ]);

    const before = await keyringFrom([entryFor(first)]);
    const legacyToken = await before.signToken({
      sub: "user-1",
      orgId: "org-1",
      sessionId: "sess-1",
    });

    const retired = await keyringFrom([entryFor(second)]);
    const { guard, context } = guardFor(retired, `Bearer ${legacyToken}`);
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("new tokens are signed under the newest key, so rotation actually moves forward", async () => {
    const [first, second] = await Promise.all([
      makeKeyMaterial("kid-old"),
      makeKeyMaterial("kid-new"),
    ]);
    const rotated = await keyringFrom([entryFor(first), entryFor(second)]);
    const token = await rotated.signToken({ sub: "u", orgId: "o", sessionId: "s" });

    const header = JSON.parse(
      Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"),
    ) as { kid?: string; alg?: string };
    expect(header.kid).toBe("kid-new");
    expect(header.alg).toBe("EdDSA");
  });

  it("an empty keyring cannot mint a token — it fails closed rather than issuing an unsigned one", async () => {
    const previous = process.env.AUTH_SIGNING_KEYS;
    delete process.env.AUTH_SIGNING_KEYS;
    const keyring = new JwtKeyringService();
    await keyring.onModuleInit();
    if (previous !== undefined) process.env.AUTH_SIGNING_KEYS = previous;

    expect(keyring.isReady()).toBe(false);
    await expect(
      keyring.signToken({ sub: "u", orgId: "o", sessionId: "s" }),
    ).rejects.toThrow(/no keys loaded/i);
    expect(keyring.getJwks()).toEqual({ keys: [] });
  });

  it("a token signed with the wrong algorithm is refused even with a matching kid", async () => {
    const material = await makeKeyMaterial("kid-1");
    const keyring = await keyringFrom([entryFor(material)]);
    const forged = [
      Buffer.from(JSON.stringify({ alg: "none", kid: "kid-1" })).toString("base64url"),
      Buffer.from(JSON.stringify({ sub: "victim", sessionId: "sess-x" })).toString("base64url"),
      "",
    ].join(".");

    expect(await keyring.verifyToken(forged)).toBeNull();
  });
});

describe("CSRF — the API carries no ambient credential a cross-site request could ride", () => {
  it("a request with a session cookie but no Authorization header is rejected", async () => {
    const keyring = await keyringFrom([entryFor(await makeKeyMaterial("kid-1"))]);
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const guard = new JwtAuthGuard(
      reflector,
      {} as unknown as Db,
      null,
      {} as unknown as MembershipStateService,
      keyring,
    );
    const req = {
      headers: {
        cookie: "next-auth.session-token=stolen-but-ambient; other=1",
      },
      path: "/api/protected",
      url: "/api/protected",
      method: "POST",
    };
    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("the guard reads the bearer header and nothing else — no cookie parsing anywhere in it", () => {
    const guard = readFileSync(
      resolve(BACKEND_ROOT, "src/common/auth/jwt-auth.guard.ts"),
      "utf8",
    );
    expect(guard).toMatch(/req\.headers\.authorization/);
    expect(guard).toMatch(/startsWith\("Bearer "\)/);
    expect(guard).not.toMatch(/req\.cookies|headers\.cookie|cookie-parser/);
  });

  it("the API sets no cookies at all, so there is nothing for a cross-site request to replay", () => {
    const cookieWriters = SOURCE_FILES.filter(
      (file) =>
        /\bres\.cookie\(/.test(file.content) ||
        /setHeader\(\s*["']Set-Cookie["']/i.test(file.content) ||
        /cookie-parser/.test(file.content),
    ).map((file) => file.path);
    expect(cookieWriters).toEqual([]);
  });

  /**
   * This used to assert the literal `req.headers["x-internal-secret"] !==
   * internalSecret`. The controller now calls `internalSecretMatches(...)`,
   * which reduces both sides to a fixed-width sha256 digest and compares them
   * with `timingSafeEqual` — strictly better code, and the old assertion went
   * red on it. A string match on the weaker spelling is also backwards as a
   * security gate: it passes for as long as nobody improves the compare, and it
   * cannot tell a real bypass from a rename. What follows drives the routes.
   */
  describe("the internal-only exchange routes require a shared secret AND a signed proof", () => {
    const NEXTAUTH_SECRET = "spec-nextauth-secret-at-least-32-chars-long-xx";
    const INTERNAL_SECRET = "spec-internal-secret-at-least-32-chars-long-xx";
    const USER_ID = "user-1";

    let controller: AuthController;
    let keyring: { isReady: jest.Mock; signToken: jest.Mock };
    let authService: { getSessionData: jest.Mock };
    let authTokens: { googleOAuth: jest.Mock };
    let rateLimit: { check: jest.Mock };
    let moduleRedis: { set: jest.Mock; get: jest.Mock };

    const originalNextAuth = process.env.NEXTAUTH_SECRET;
    const originalInternal = process.env.INTERNAL_API_SECRET;

    async function proofSignedWith(
      secret: string,
      claims: { issuer?: string; audience?: string } = {},
    ): Promise<string> {
      return new SignJWT({ sessionId: "session-1" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(USER_ID)
        .setIssuer(claims.issuer ?? SESSION_PROOF_ISSUER)
        .setAudience(claims.audience ?? SESSION_PROOF_AUDIENCE)
        .setJti(randomUUID())
        .setIssuedAt()
        .setExpirationTime("30s")
        .sign(new TextEncoder().encode(secret));
    }

    beforeEach(async () => {
      process.env.NEXTAUTH_SECRET = NEXTAUTH_SECRET;
      process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;

      keyring = {
        isReady: jest.fn().mockReturnValue(true),
        signToken: jest.fn().mockResolvedValue("signed.jwt"),
      };
      authService = { getSessionData: jest.fn().mockResolvedValue({ userId: USER_ID }) };
      authTokens = { googleOAuth: jest.fn().mockResolvedValue({ token: "t" }) };
      rateLimit = { check: jest.fn().mockResolvedValue({ allowed: true, retryAfterSecs: 0 }) };
      moduleRedis = { set: jest.fn().mockResolvedValue("OK"), get: jest.fn().mockResolvedValue(null) };

      const moduleRef = await Test.createTestingModule({
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
          { provide: REDIS, useValue: moduleRedis },
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

    it("refuses a wrong shared secret and mints nothing", async () => {
      const proof = await proofSignedWith(NEXTAUTH_SECRET);
      for (const presented of [
        `${INTERNAL_SECRET.slice(0, -1)}z`,
        INTERNAL_SECRET.slice(0, -1),
        `${INTERNAL_SECRET}extra`,
        "",
      ]) {
        await expect(
          controller.sessionExchange(
            { orgId: null },
            { headers: { "x-internal-secret": presented, "x-session-proof": proof } },
          ),
        ).rejects.toMatchObject({ status: 403 });
      }
      await expect(
        controller.sessionExchange({ orgId: null }, { headers: { "x-session-proof": proof } }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        controller.getSessionData(USER_ID, { headers: { "x-internal-secret": "wrong" } }),
      ).rejects.toMatchObject({ status: 403 });

      expect(keyring.signToken).not.toHaveBeenCalled();
      expect(authService.getSessionData).not.toHaveBeenCalled();
    });

    it("refuses the right secret without a valid signed proof — the secret alone is not identity", async () => {
      const headers = { "x-internal-secret": INTERNAL_SECRET };
      await expect(
        controller.sessionExchange({ orgId: null }, { headers }),
      ).rejects.toMatchObject({ status: 403 });

      for (const proof of [
        await proofSignedWith("a-different-secret-of-sufficient-length-xx"),
        await proofSignedWith(NEXTAUTH_SECRET, { issuer: "https://evil.example" }),
        await proofSignedWith(NEXTAUTH_SECRET, { audience: "some-other-audience" }),
        "not.a.jwt",
      ]) {
        await expect(
          controller.sessionExchange(
            { orgId: null },
            { headers: { ...headers, "x-session-proof": proof } },
          ),
        ).rejects.toMatchObject({ status: 401 });
      }
      expect(keyring.signToken).not.toHaveBeenCalled();
    });

    it("refuses to replay a proof it has already spent, so a captured header is single-use", async () => {
      const proof = await proofSignedWith(NEXTAUTH_SECRET);
      const headers = { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof };
      const redis = moduleRedis;
      redis.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

      await expect(controller.sessionExchange({ orgId: null }, { headers })).resolves.toEqual({
        token: "signed.jwt",
      });
      await expect(
        controller.sessionExchange({ orgId: null }, { headers }),
      ).rejects.toMatchObject({ status: 401 });
      expect(keyring.signToken).toHaveBeenCalledTimes(1);
    });

    it("CONTROL: the right secret and a valid proof do mint a token, so this is not a blanket deny", async () => {
      const proof = await proofSignedWith(NEXTAUTH_SECRET);
      await expect(
        controller.sessionExchange(
          { orgId: null },
          { headers: { "x-internal-secret": INTERNAL_SECRET, "x-session-proof": proof } },
        ),
      ).resolves.toEqual({ token: "signed.jwt" });
      expect(keyring.signToken).toHaveBeenCalledTimes(1);
    });

    /**
     * The comparison itself is timing-safe, which no black-box assertion can
     * see: a plain `!==` rejects exactly the same inputs. Two things are
     * checkable and both are asserted — that a length mismatch is answered
     * `false` rather than thrown (a naive `timingSafeEqual` on raw strings
     * throws on unequal lengths, so surviving it is evidence of the fixed-width
     * digest), and that the compare is the only spelling in the tree.
     */
    it("compares the shared secret in constant time, and no raw !== compare survives", () => {
      expect(internalSecretMatches(INTERNAL_SECRET, INTERNAL_SECRET)).toBe(true);
      expect(internalSecretMatches(INTERNAL_SECRET, `${INTERNAL_SECRET}-much-much-longer`)).toBe(false);
      expect(internalSecretMatches(INTERNAL_SECRET, "x")).toBe(false);
      expect(internalSecretMatches(undefined, "")).toBe(false);
      expect(internalSecretMatches("", "")).toBe(false);

      const compare = readFileSync(
        resolve(BACKEND_ROOT, "src/modules/auth/internal-secret.ts"),
        "utf8",
      );
      expect(compare).toMatch(/timingSafeEqual/);

      const rawCompares = SOURCE_FILES.filter((file) =>
        /(?:!==|===)\s*(?:process\.env\.INTERNAL_API_SECRET|internalSecret\b)/.test(file.content),
      ).map((file) => file.path);
      expect(rawCompares).toEqual([]);
    });
  });
});

describe("Secret redaction", () => {
  it("credential-bearing fields never survive into a log record", () => {
    const emitted = JSON.stringify(
      redact({
        authorization: "Bearer eyJhbGciOiJFZERTQSJ9.super-secret-token",
        cookie: "next-auth.session-token=abcdef",
        password: "hunter2-the-real-one",
        apiKey: "sk_live_51H8ZzZ",
        token: "ml_0123456789abcdef",
        secret: "INTERNAL-SECRET-VALUE",
        nested: { accessToken: "at_should_not_appear" },
      }),
    );

    for (const leak of [
      "super-secret-token",
      "abcdef",
      "hunter2-the-real-one",
      "sk_live_51H8ZzZ",
      "ml_0123456789abcdef",
      "INTERNAL-SECRET-VALUE",
      "at_should_not_appear",
    ]) {
      expect({ leak, present: emitted.includes(leak) }).toEqual({ leak, present: false });
    }
  });

  it("BITE: a non-sensitive field is left alone, so the redaction above is selective, not blanket", () => {
    const emitted = JSON.stringify(redact({ orgId: "org-123", module: "billing", count: 4 }));
    expect(emitted).toContain("org-123");
    expect(emitted).toContain("billing");
  });

  it("deployment secrets have no defaults and a length floor, so an unset one cannot pass as configured", () => {
    const env = readFileSync(resolve(BACKEND_ROOT, "src/config/env.validation.ts"), "utf8");
    expect(env).toMatch(/const deploymentSecret = z\.string\(\)\.min\(32\)/);
    for (const name of ["CRON_SECRET", "INTERNAL_API_SECRET", "NEXTAUTH_SECRET"]) {
      expect({ name, declared: env.includes(name) }).toEqual({ name, declared: true });
      expect(new RegExp(`${name}:[^\\n]*\\.default\\(`).test(env)).toBe(false);
    }
    expect(env).toMatch(/ENCRYPTION_KEY[\s\S]{0,200}?\.min\(32,/);
  });

  it("env validation refuses a short secret rather than booting with it", () => {
    const base = {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://user:pw@localhost:5432/db",
      CORS_ORIGINS: "https://app.example.com",
      APP_URL: "https://app.example.com",
      ENCRYPTION_KEY: "an-encryption-key-of-at-least-32-characters",
    };
    expect(() => validateEnv({ ...base, INTERNAL_API_SECRET: "too-short" })).toThrow(/\[env\]/);
    expect(() => validateEnv({ ...base, ENCRYPTION_KEY: "short" })).toThrow(/ENCRYPTION_KEY/);
  });

  it("no signing key, encryption key or deployment secret is hard-coded in src", () => {
    const offenders: string[] = [];
    const patterns: Array<[string, RegExp]> = [
      ["inline private JWK", /"d"\s*:\s*"[A-Za-z0-9_-]{20,}"/],
      ["inline PEM private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
      ["assigned signing keys", /AUTH_SIGNING_KEYS\s*=\s*["'`]\s*\[/],
      ["assigned encryption key", /ENCRYPTION_KEY\s*=\s*["'][^"']{8,}["']/],
      ["assigned internal secret", /INTERNAL_API_SECRET\s*=\s*["'][^"']{8,}["']/],
    ];
    for (const file of SOURCE_FILES) {
      for (const [label, pattern] of patterns) {
        if (pattern.test(file.content)) offenders.push(`${file.path} (${label})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { Redis } from "@upstash/redis";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { JwtAuthGuard } from "../../../src/common/auth/jwt-auth.guard";
import { JwtKeyringService } from "../../../src/common/auth/jwt-keyring.service";
import type { MembershipStateService } from "../../../src/common/auth/membership-state.service";
import { redact } from "../../../src/common/observability/redact";
import { validateEnv } from "../../../src/config/env.validation";
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

  it("the two internal-only exchange routes require a shared secret AND a signed proof", () => {
    const controller = readFileSync(
      resolve(BACKEND_ROOT, "src/modules/auth/auth.controller.ts"),
      "utf8",
    );
    const exchange = controller.slice(
      controller.indexOf('@Post("session-exchange")'),
      controller.indexOf('@Get(".well-known/jwks.json")'),
    );
    expect(exchange).toContain('req.headers["x-internal-secret"] !== internalSecret');
    expect(exchange).toContain('req.headers["x-session-proof"]');
    expect(exchange).toContain("jwtVerify(");
    expect(exchange).toContain('algorithms: ["HS256"]');
    expect(exchange).toContain("issuer: SESSION_PROOF_ISSUER");
    expect(exchange).toContain("audience: SESSION_PROOF_AUDIENCE");
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

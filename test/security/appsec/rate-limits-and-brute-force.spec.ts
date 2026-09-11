import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { HttpException, HttpStatus } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { RateLimitGuard } from "../../../src/common/ratelimit/rate-limit.guard";
import {
  RateLimitService,
  effectiveRateLimit,
} from "../../../src/common/ratelimit/rate-limit.service";

const BACKEND_ROOT = resolve(__dirname, "../../..");

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

function service(): RateLimitService {
  return new RateLimitService(null);
}

function guardFor(tier: string | undefined, svc: RateLimitService): RateLimitGuard {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(tier) } as unknown as Reflector;
  return new RateLimitGuard(reflector, svc);
}

function contextFor(options: { userId?: string; ip?: string; forwardedFor?: string }): {
  context: ExecutionContext;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  const req: Record<string, unknown> = {
    ip: options.ip ?? "203.0.113.9",
    headers: options.forwardedFor === undefined ? {} : { "x-forwarded-for": options.forwardedFor },
  };
  if (options.userId !== undefined) req.user = { userId: options.userId };
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
  };
  return {
    headers,
    context: {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext,
  };
}

async function statusOf(guard: RateLimitGuard, context: ExecutionContext): Promise<number> {
  try {
    await guard.canActivate(context);
    return 200;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : 500;
  }
}

describe("Rate-limit tiers fail closed on an unknown tier", () => {
  it("the service denies an undeclared tier instead of allowing it", async () => {
    const result = await service().check("totally-made-up-tier", "ip-1");
    expect(result).toEqual({ allowed: false, retryAfterSecs: 60 });
  });

  it("a typo in an otherwise real tier name is denied, not silently unlimited", async () => {
    for (const typo of ["auth:logn", "auth:login ", "AUTH:LOGIN", "", "public:contacts"]) {
      const result = await service().check(typo, "ip-1");
      expect({ typo, allowed: result.allowed }).toEqual({ typo, allowed: false });
    }
  });

  it("the guard turns an unknown tier into a 429 on the very first request", async () => {
    const { context } = contextFor({ userId: "user-1" });
    expect(await statusOf(guardFor("nonexistent-tier", service()), context)).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });

  it("CONTROL: a declared tier lets the first request through, so the deny above is about the tier", async () => {
    const { context } = contextFor({ userId: "user-1" });
    expect(await statusOf(guardFor("auth:login", service()), context)).toBe(200);
  });

  it("effectiveRateLimit reports 0 for an unknown tier, which is the deny signal callers read", () => {
    expect(effectiveRateLimit("nonexistent-tier")).toBe(0);
    expect(effectiveRateLimit("auth:login")).toBeGreaterThan(0);
  });

  it("every literal tier used anywhere in src is declared", () => {
    const referenced = new Set<string>();
    const patterns = [
      /UseRateLimit\(\s*"([^"$]+)"/g,
      /enforceRateLimit\(\s*"([^"$]+)"/g,
      /rateLimit\.check\(\s*"([^"$]+)"/g,
      /rateLimitService\.check\(\s*"([^"$]+)"/g,
    ];
    for (const file of SOURCE_FILES) {
      for (const pattern of patterns) {
        for (const match of file.content.matchAll(pattern)) {
          if (match[1] !== undefined) referenced.add(match[1]);
        }
      }
    }

    expect(referenced.size).toBeGreaterThanOrEqual(50);
    const undeclared = [...referenced].filter((tier) => effectiveRateLimit(tier) === 0).sort();
    expect(undeclared).toEqual([]);
  });
});

describe("The dev multiplier must not mask the 429 a test asserts", () => {
  const DECLARED_LOGIN_LIMIT = 5;

  it("outside production the enforced limit is ten times the declared one", () => {
    expect(process.env.NODE_ENV).not.toBe("production");
    expect(effectiveRateLimit("auth:login")).toBe(DECLARED_LOGIN_LIMIT * 10);
  });

  it("TRAP: exhausting only the declared limit never produces a 429 here", async () => {
    const svc = service();
    for (let i = 0; i < DECLARED_LOGIN_LIMIT; i += 1) {
      await svc.check("auth:login", "trap-identifier");
    }
    const next = await svc.check("auth:login", "trap-identifier");
    expect(next.allowed).toBe(true);
  });

  it("exhausting effectiveRateLimit() does produce the 429, on every auth tier", async () => {
    for (const tier of ["auth:login", "auth:mfa-verify", "auth:email-otp-verify", "auth:register"]) {
      const svc = service();
      const limit = effectiveRateLimit(tier);
      expect(limit).toBeGreaterThan(0);
      for (let i = 0; i < limit; i += 1) {
        const allowed = await svc.check(tier, `victim@${tier}`);
        expect({ tier, i, allowed: allowed.allowed }).toEqual({ tier, i, allowed: true });
      }
      const blocked = await svc.check(tier, `victim@${tier}`);
      expect({ tier, allowed: blocked.allowed }).toEqual({ tier, allowed: false });
      expect(blocked.retryAfterSecs).toBeGreaterThan(0);
    }
  });
});

describe("Brute force and credential stuffing", () => {
  it("a login flood from one address is cut off with a 429 carrying Retry-After", async () => {
    const svc = service();
    const limit = effectiveRateLimit("auth:login");
    const attacker = contextFor({ ip: "198.51.100.7" });
    const guard = guardFor("auth:login", svc);

    for (let i = 0; i < limit; i += 1) {
      expect(await statusOf(guard, attacker.context)).toBe(200);
    }
    expect(await statusOf(guard, attacker.context)).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(Number(attacker.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("credential stuffing across many accounts from one address still hits the per-address budget", async () => {
    const svc = service();
    const limit = effectiveRateLimit("auth:email-otp-verify");
    const guard = guardFor("auth:email-otp-verify", svc);
    const attacker = contextFor({ forwardedFor: "198.51.100.8, 10.0.0.1" });

    for (let i = 0; i < limit; i += 1) {
      expect(await statusOf(guard, attacker.context)).toBe(200);
    }
    expect(await statusOf(guard, attacker.context)).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it("one attacker's exhaustion does not lock out an unrelated address", async () => {
    const svc = service();
    const limit = effectiveRateLimit("auth:login");
    const guard = guardFor("auth:login", svc);
    const attacker = contextFor({ ip: "198.51.100.9" });
    const bystander = contextFor({ ip: "198.51.100.10" });

    for (let i = 0; i <= limit; i += 1) await statusOf(guard, attacker.context);

    expect(await statusOf(guard, attacker.context)).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(await statusOf(guard, bystander.context)).toBe(200);
  });

  it("an authenticated caller is keyed by user id, so rotating source addresses does not reset the budget", async () => {
    const svc = service();
    const limit = effectiveRateLimit("auth:mfa-verify");
    const guard = guardFor("auth:mfa-verify", svc);

    for (let i = 0; i < limit; i += 1) {
      const rotating = contextFor({ userId: "victim-user", ip: `192.0.2.${i % 250}` });
      expect(await statusOf(guard, rotating.context)).toBe(200);
    }
    const nextAddress = contextFor({ userId: "victim-user", ip: "192.0.2.251" });
    expect(await statusOf(guard, nextAddress.context)).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  /**
   * REPLACED, because the property this pinned was the wrong sign.
   *
   * It asserted that the SAME first hop with a DIFFERENT tail shares a bucket — true under the
   * defect and true under the fix, and never the direction an attacker moves. A proxy APPENDS
   * to the header, so the leftmost entry is the one the CLIENT writes; rotating it was what
   * bought a fresh budget, and nothing here rotated it. The guard no longer reads the header at
   * all, so what is pinned now is that the header cannot SPLIT a bucket either. The full
   * reproduction, the trust-proxy hop arithmetic and the source backstop live in
   * `client-ip-forgery.spec.ts`.
   */
  it("a forwarded-for list cannot split one caller into two buckets, whatever hop it names", async () => {
    const svc = service();
    const limit = effectiveRateLimit("auth:login");
    const guard = guardFor("auth:login", svc);
    const first = contextFor({ ip: "203.0.113.5", forwardedFor: "203.0.113.5, 70.41.3.18" });
    const differentFirstHop = contextFor({ ip: "203.0.113.5", forwardedFor: "8.8.8.8, 9.9.9.9" });
    const noHeaderAtAll = contextFor({ ip: "203.0.113.5" });

    for (let i = 0; i < limit; i += 1) await statusOf(guard, first.context);
    expect(await statusOf(guard, differentFirstHop.context)).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(await statusOf(guard, noHeaderAtAll.context)).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it("no controller declares @UseRateLimit without also mounting RateLimitGuard — the decorator alone is inert", () => {
    const decorated = SOURCE_FILES.filter((file) => /@UseRateLimit\(/.test(file.content));
    expect(decorated.length).toBeGreaterThanOrEqual(10);

    const inert = decorated
      .filter((file) => !/RateLimitGuard/.test(file.content))
      .map((file) => file.path);
    expect(inert).toEqual([]);
  });

  it("the guard is a no-op only when a route declares no tier at all", async () => {
    const { context } = contextFor({ userId: "user-1" });
    expect(await statusOf(guardFor(undefined, service()), context)).toBe(200);
  });

  it("the auth tiers that gate a credential are all small enough to matter", () => {
    const multiplier = effectiveRateLimit("auth:login") / 5;
    const declared = (tier: string): number => effectiveRateLimit(tier) / multiplier;

    expect(declared("auth:login")).toBeLessThanOrEqual(10);
    expect(declared("auth:register")).toBeLessThanOrEqual(5);
    expect(declared("auth:magic-link")).toBeLessThanOrEqual(5);
    expect(declared("auth:email-otp")).toBeLessThanOrEqual(5);
    expect(declared("auth:mfa-verify")).toBeLessThanOrEqual(10);
    expect(declared("auth:mfa-disable")).toBeLessThanOrEqual(10);
  });
});

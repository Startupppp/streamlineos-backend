/**
 * The header that defeated every unauthenticated rate limit.
 *
 * THE DEFECT. `RateLimitGuard.extractClientIp` and `common/http/client-ip.ts`'s
 * `resolveClientIp` both read `x-forwarded-for` and took `split(",")[0]`. A proxy APPENDS its
 * peer to that header — it never prepends — so the leftmost entry is exactly the string the
 * CLIENT sent. Every unauthenticated tier was therefore keyed on a value the caller chooses.
 * Reproduced against the real guard and the real service before the fix: `auth:magic-link`,
 * 150 requests from a FIXED first hop -> 120 answered 429; the same 150 with a ROTATING first
 * hop -> 0 answered 429. Nothing in `src/` or `test/` set `trust proxy`, so `req.ip` — the one
 * value Express derives safely — was only ever a fallback.
 *
 * The spec that looked like coverage asserted the opposite-signed property: it pinned that the
 * SAME first hop with a DIFFERENT tail shares a bucket. That holds under the defect and under
 * the fix, and it never rotated the first hop for an unauthenticated caller, which is the only
 * direction an attacker can move.
 *
 * WHAT IS ASSERTED HERE, in the order it matters:
 *
 *   1. BEHAVIOUR, the reproduction inverted — an unauthenticated caller rotating the first hop
 *      150 times is still blocked, and the run is checked against the tier's own limit so it
 *      cannot pass by exhausting nothing.
 *   2. BEHAVIOUR, real Express — the `trust proxy` setting this repository installs is driven
 *      through an actual Express app and `req.ip` is read back, with a forged header on the
 *      wire. This is the half that decides whether the hop arithmetic is right, and a source
 *      grep cannot see it.
 *   3. SOURCE, as a backstop only — neither IP reader may reach for the header again.
 */
import express from "express";
import request from "supertest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { HttpException, HttpStatus } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { RateLimitGuard } from "../../../src/common/ratelimit/rate-limit.guard";
import { RateLimitService, effectiveRateLimit } from "../../../src/common/ratelimit/rate-limit.service";
import { trustProxyHops, trustProxySetting, trustProxyWarning } from "../../../src/common/http/trust-proxy";
import { resolveClientIp } from "../../../src/common/http/client-ip";

const BACKEND_ROOT = resolve(__dirname, "../../..");

function guardFor(tier: string, svc: RateLimitService): RateLimitGuard {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(tier) } as unknown as Reflector;
  return new RateLimitGuard(reflector, svc, {} as never, {} as never);
}

/** One request as the framework hands it over: a socket-derived `ip` plus whatever headers arrived. */
function contextFor(options: { ip: string; forwardedFor?: string }): ExecutionContext {
  const req: Record<string, unknown> = {
    ip: options.ip,
    headers: options.forwardedFor === undefined ? {} : { "x-forwarded-for": options.forwardedFor },
  };
  const res = { setHeader: () => {} };
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

async function statusOf(guard: RateLimitGuard, context: ExecutionContext): Promise<number> {
  try {
    await guard.canActivate(context);
    return 200;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : 500;
  }
}

/** An Express app carrying whatever `trust proxy` value is asked for, answering with `req.ip`. */
function appWith(trustProxy: number | false) {
  const app = express();
  app.set("trust proxy", trustProxy);
  app.get("/whoami", (req, res) => {
    res.json({ ip: req.ip, resolved: resolveClientIp(req) });
  });
  return app;
}

describe("client ip cannot be forged by the caller", () => {
  const TIER = "auth:magic-link";
  const ATTEMPTS = 150;

  it("ANTI-VACUITY — the tier really does block a fixed caller inside this many attempts", async () => {
    const limit = effectiveRateLimit(TIER);
    expect(limit).toBeLessThan(ATTEMPTS);

    const guard = guardFor(TIER, new RateLimitService(null));
    const statuses: number[] = [];
    for (let i = 0; i < ATTEMPTS; i += 1)
      statuses.push(await statusOf(guard, contextFor({ ip: "198.51.100.7" })));

    expect(statuses.filter((status) => status === HttpStatus.TOO_MANY_REQUESTS).length).toBe(
      ATTEMPTS - limit,
    );
  });

  it("a rotating first hop no longer buys a fresh budget for an unauthenticated caller", async () => {
    const limit = effectiveRateLimit(TIER);
    const guard = guardFor(TIER, new RateLimitService(null));
    const statuses: number[] = [];
    for (let i = 0; i < ATTEMPTS; i += 1)
      statuses.push(
        await statusOf(
          guard,
          contextFor({ ip: "198.51.100.7", forwardedFor: `192.0.2.${i % 250}, 10.0.0.1` }),
        ),
      );

    const blocked = statuses.filter((status) => status === HttpStatus.TOO_MANY_REQUESTS).length;
    expect(blocked).toBe(ATTEMPTS - limit);
  });

  it("a rotating whole header, list or single value, is likewise inert", async () => {
    const limit = effectiveRateLimit(TIER);
    const guard = guardFor(TIER, new RateLimitService(null));
    let blocked = 0;
    for (let i = 0; i < ATTEMPTS; i += 1) {
      const header = i % 2 === 0 ? `203.0.113.${i % 250}` : `203.0.113.${i % 250}, 9.9.9.9, 8.8.8.8`;
      if ((await statusOf(guard, contextFor({ ip: "198.51.100.8", forwardedFor: header }))) === HttpStatus.TOO_MANY_REQUESTS)
        blocked += 1;
    }
    expect(blocked).toBe(ATTEMPTS - limit);
  });

  it("CONTROL — two genuinely different socket addresses still get their own budget", async () => {
    const limit = effectiveRateLimit(TIER);
    const guard = guardFor(TIER, new RateLimitService(null));
    for (let i = 0; i < limit; i += 1)
      expect(await statusOf(guard, contextFor({ ip: "198.51.100.20" }))).toBe(200);

    expect(await statusOf(guard, contextFor({ ip: "198.51.100.20" }))).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
    expect(await statusOf(guard, contextFor({ ip: "198.51.100.21" }))).toBe(200);
  });

  describe("the trust-proxy declaration, driven through a real Express app", () => {
    it("ignores a forged header entirely when no hops are declared", async () => {
      expect(trustProxySetting({} as NodeJS.ProcessEnv)).toBe(false);
      const res = await request(appWith(trustProxySetting({} as NodeJS.ProcessEnv)))
        .get("/whoami")
        .set("X-Forwarded-For", "1.2.3.4, 5.6.7.8");
      expect(res.body.ip).not.toBe("1.2.3.4");
      expect(res.body.resolved).toBe(res.body.ip);
    });

    it("counts declared hops from the RIGHT, so prepended entries cannot move the answer", async () => {
      const app = appWith(1);
      const honest = await request(app).get("/whoami").set("X-Forwarded-For", "203.0.113.5");
      const forged = await request(app)
        .get("/whoami")
        .set("X-Forwarded-For", "1.1.1.1, 2.2.2.2, 203.0.113.5");
      expect(honest.body.ip).toBe("203.0.113.5");
      expect(forged.body.ip).toBe("203.0.113.5");
    });

    it("says so at boot when production declares no hops (SEC-HRMS-002)", () => {
      expect(trustProxyWarning({ NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv)).toMatch(/TRUST_PROXY_HOPS/);
      expect(trustProxyWarning({ NODE_ENV: "production", TRUST_PROXY_HOPS: "2" } as unknown as NodeJS.ProcessEnv)).toBeNull();
      expect(trustProxyWarning({ NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    });

    it("reads the hop count from the environment and refuses a value it cannot trust", () => {
      expect(trustProxyHops({} as NodeJS.ProcessEnv)).toBe(0);
      expect(trustProxyHops({ TRUST_PROXY_HOPS: "2" } as unknown as NodeJS.ProcessEnv)).toBe(2);
      expect(trustProxySetting({ TRUST_PROXY_HOPS: "2" } as unknown as NodeJS.ProcessEnv)).toBe(2);
      for (const bad of ["-1", "1.5", "many"])
        expect(() => trustProxyHops({ TRUST_PROXY_HOPS: bad } as unknown as NodeJS.ProcessEnv)).toThrow(
          /TRUST_PROXY_HOPS/,
        );
    });
  });

  /**
   * The corpus is the WHOLE of `src/`, deliberately — not the files this change touched.
   *
   * The header read was never in one place: ELEVEN more files had rolled their own copy of
   * `req.headers["x-forwarded-for"]?.split(",")?.[0]`, and eight of them keyed a rate limiter
   * on it — organization, kb-public-pages, auth, operator-session.guard, platform, sessions,
   * support-csat, support-channels, hr-forms-public, survey-public. A backstop scoped to the
   * two files that were fixed first would have been structurally unable to see any of them,
   * and equally unable to see the twelfth when someone writes it.
   */
  describe("the source backstop, over all of src/", () => {
    const SPOOFABLE_ADDRESS_HEADERS = /x-forwarded-for|x-real-ip|x-client-ip/i;
    const withoutComments = (source: string): string =>
      source.replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "");

    function walk(dir: string, out: string[] = []): string[] {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (full.endsWith(".ts") && !full.endsWith("spec.ts") && !full.endsWith(".d.ts"))
          out.push(full);
      }
      return out;
    }

    const SOURCES = walk(resolve(BACKEND_ROOT, "src")).map((file) => ({
      path: relative(BACKEND_ROOT, file).split("\\").join("/"),
      content: readFileSync(file, "utf8"),
    }));

    it("scans enough of src that a broken walk cannot pass vacuously", () => {
      expect(SOURCES.length).toBeGreaterThan(1500);
      expect(SOURCES.some((file) => file.path === "src/common/http/client-ip.ts")).toBe(true);
      expect(SOURCES.some((file) => file.path === "src/main.ts")).toBe(true);
    });

    it("no file in src derives a caller address from a header the caller can write", () => {
      const offenders = SOURCES.filter((file) => SPOOFABLE_ADDRESS_HEADERS.test(withoutComments(file.content))).map(
        (file) => file.path,
      );
      expect(offenders).toEqual(["src/modules/auth/auth.controller.ts"]);
    });

    it("SELF-TEST: a header named only in prose is not an offender, and the same header read in code still is", () => {
      const prose = "/**\n * `x-client-ip` is set by the Next server.\n */\n// x-forwarded-for is never read\nexport const a = 1;\n";
      const read = 'const ip = req.headers["x-forwarded-for"]; // x-real-ip\n';
      const trailing = "/** doc */ const ip = req.headers[\"x-real-ip\"];\n";
      expect(SPOOFABLE_ADDRESS_HEADERS.test(withoutComments(prose))).toBe(false);
      expect(SPOOFABLE_ADDRESS_HEADERS.test(withoutComments(read))).toBe(true);
      expect(SPOOFABLE_ADDRESS_HEADERS.test(withoutComments(trailing))).toBe(true);
    });

    /**
     * The single exception, asserted rather than excused. `auth.controller.ts` may believe
     * `x-client-ip` because the web tier's server-side auth bridge is not a proxy and appends
     * no forwarded-for header — but ONLY on the routes that have already verified
     * INTERNAL_API_SECRET, which is what `"internal-secret-verified"` marks. The `@Public()`
     * magic-link verify route passes `"untrusted"` and gets `req.ip`.
     */
    it("the one file that still names such a header believes it only behind the internal secret", () => {
      const source = readFileSync(resolve(BACKEND_ROOT, "src/modules/auth/auth.controller.ts"), "utf8");
      expect(source).not.toMatch(/x-forwarded-for|x-real-ip/i);
      expect(source).toContain('trusted === "internal-secret-verified" ? req.headers["x-client-ip"]');
      expect(source).toContain('this.resolveClientContext(req, "untrusted")');
      expect((source.match(/resolveClientContext\(req, "internal-secret-verified"\)/g) ?? []).length).toBe(1);
    });

    it("neither central ip reader reaches for a header at all", () => {
      for (const rel of ["src/common/http/client-ip.ts", "src/common/ratelimit/rate-limit.guard.ts"]) {
        const source = readFileSync(resolve(BACKEND_ROOT, rel), "utf8");
        expect([rel, SPOOFABLE_ADDRESS_HEADERS.test(source)]).toEqual([rel, false]);
        expect([rel, /req\.headers/.test(source)]).toEqual([rel, false]);
      }
    });

    it("the bootstrap declares trust proxy, without which req.ip is only ever the socket", () => {
      const main = readFileSync(resolve(BACKEND_ROOT, "src/main.ts"), "utf8");
      expect(main).toContain('app.set("trust proxy", trustProxySetting())');
    });
  });
});

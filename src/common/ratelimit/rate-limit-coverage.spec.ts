import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Box 7, per-tenant limits — "establish whether opt-in rate limiting is
 * deliberate, and record it, because §4 reads as though limits are ambient".
 *
 * It is deliberate. `RateLimitGuard` is not an `APP_GUARD` and making it one
 * would change nothing on its own: `rate-limit.guard.ts` returns true when no
 * tier is declared, so the guard is a no-op everywhere a route has not opted
 * in. Ambient limiting would require a *default tier* for ~3,500 handlers —
 * a capacity decision, not a wiring one. Backend §4 asks for limits on
 * "abusable flows (signup, purchase)" and on login, which is a targeted
 * instruction; the ambient layer in this system is admission control, which IS
 * an `APP_GUARD` and bounds concurrency, queue depth, per-org concurrency and
 * body size for every route.
 *
 * What targeting lacks is a way to notice a flow that never opted in. The
 * failure mode is silent — the route looks like every other route — and it has
 * bitten repeatedly: the TIERS table's own comments record SEC-004 (three
 * routes decorated with an unregistered tier, so the guard passed while looking
 * protected) and the fourth INTERNAL_API_SECRET route. So the invariant is
 * pinned here instead: an unauthenticated write is an abusable flow by
 * definition, and one that acquires no limiter fails this spec.
 */

const CONTROLLER_ROOT = resolve(__dirname, "../..");
const ROUTE = /^\s*@(Get|Post|Put|Patch|Delete|All)\(/;
const WRITE = /^\s*@(Post|Put|Patch|Delete)\(/;
const DECORATOR_OR_COMMENT = /^\s*(@|\/\*|\s*\*|\/\/)/;

function controllerFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) controllerFiles(full, found);
    else if (entry.endsWith(".controller.ts")) found.push(full);
  }
  return found;
}

function declaredTiers(): string[] {
  const source = readFileSync(join(__dirname, "rate-limit.service.ts"), "utf8");
  const table = source.slice(
    source.indexOf("const TIERS"),
    source.indexOf("const DEV_LIMIT_MULTIPLIER"),
  );
  return [...table.matchAll(/^\s*"([^"]+)":\s*\{/gm)].map((match) => match[1] ?? "");
}

interface Handler {
  /**
   * STABLE IDENTITY — `<file>:<VERB> <route path>`, deliberately NOT a line
   * number. The registry below was keyed on `<file>:<line>` and that made an
   * unrelated edit red this suite: `09c01de8` added one import to
   * internal-audit.controller.ts, the `@Post("audit")` handler moved from line
   * 12 to 13, and both set-equality assertions failed while the rate-limit gap
   * itself was completely unchanged. The only way to green it was to edit the
   * registry — which is indistinguishable from editing a baseline to make a
   * regression go away, and this is a security registry to be teaching that
   * reflex on. Route verb + path is unique per handler (check:route-duplicates
   * enforces that) and survives every edit that does not move the route.
   */
  id: string;
  location: string;
  decorators: string;
  body: string;
}

function publicWriteHandlers(): Handler[] {
  const handlers: Handler[] = [];

  for (const file of controllerFiles(CONTROLLER_ROOT)) {
    const lines = readFileSync(file, "utf8").split("\n");
    const routeLines: number[] = [];
    for (let i = 0; i < lines.length; i++) if (ROUTE.test(lines[i] ?? "")) routeLines.push(i);

    for (let index = 0; index < routeLines.length; index++) {
      const route = routeLines[index] ?? 0;
      if (!WRITE.test(lines[route] ?? "")) continue;

      let top = route;
      while (top > 0 && DECORATOR_OR_COMMENT.test(lines[top - 1] ?? "")) top -= 1;

      let signature = route + 1;
      while (signature < lines.length && DECORATOR_OR_COMMENT.test(lines[signature] ?? ""))
        signature += 1;

      const nextRoute = routeLines[index + 1];
      let end = nextRoute ?? lines.length;
      while (end > signature && DECORATOR_OR_COMMENT.test(lines[end - 1] ?? "")) end -= 1;

      const decorators = lines.slice(top, signature).join("\n");
      if (!decorators.includes("@Public()")) continue;

      const rel = relative(CONTROLLER_ROOT, file).replace(/\\/g, "/");
      const routeLine = lines[route] ?? "";
      const verb = /@(Post|Put|Patch|Delete)\(/.exec(routeLine)?.[1] ?? "";
      const routePath = /@\w+\(\s*["'`]([^"'`]*)["'`]/.exec(routeLine)?.[1] ?? "";

      handlers.push({
        id: `${rel}:${verb} ${routePath}`,
        location: `${rel}:${String(route + 1)}`,
        decorators,
        body: lines.slice(signature, end).join("\n"),
      });
    }
  }

  return handlers;
}

/**
 * Every unauthenticated write that has EVER been recorded here as carrying no
 * limiter. Frozen: this list may not gain a member. It is what makes the gap map
 * below SHRINK-ONLY — a fifth gap cannot be quietly appended to
 * `UNLIMITED_PUBLIC_WRITES`, because a key that is not in this list fails the
 * shrink-only case regardless of what comment is attached to it.
 */
const EVER_RECORDED_AS_UNLIMITED: readonly string[] = [
  "common/audit/internal-audit.controller.ts:Post audit",
  "modules/careers/careers.controller.ts:Post apply",
  "modules/csat/csat.controller.ts:Post public/:publicToken/responses",
  "modules/ingress/adapters/crm-mailbox.controller.ts:Post push",
];

/**
 * The three closed here, with the tier each was wired to. Named rather than
 * deleted outright, so the shrink is auditable and so the "every gap is closed
 * for the reason it was recorded" case can re-derive it from the source.
 */
const CLOSED_PUBLIC_WRITE_GAPS: Readonly<Record<string, string>> = {
  "modules/careers/careers.controller.ts:Post apply": "public:job-apply",
  "modules/csat/csat.controller.ts:Post :surveyId/responses": "csat:submit",
  "common/audit/internal-audit.controller.ts:Post audit": "internal:audit",
};

/**
 * Unauthenticated writes that carry no limiter of any kind today. Each is a
 * real gap, not an exemption — they are listed so the count cannot grow
 * silently, and each names the owner who has to close it.
 */
const UNLIMITED_PUBLIC_WRITES: Readonly<Record<string, string>> = {
  "modules/ingress/adapters/crm-mailbox.controller.ts:Post push":
    'POST /crm/mailboxes/push — an HMAC-signed inbound webhook. Every comparable one is limited ("webhook:email" 600/60, "billing:webhook" 600/60, "support:inbound-email" 120/60). Owner: crm ingress owner.',
};

/**
 * Tiers declared with no route to apply them to. Recorded rather than deleted:
 * a stale entry makes the table read as though a limiter is wired, which is the
 * `auth:login` case below — and that one is load-bearing for a gate script.
 */
const TIERS_WITH_NO_ROUTE: Readonly<Record<string, string>> = {
  "auth:login":
    "There is no POST /auth/login in this repository. The only credentials provider is a magic-link token verified at POST /auth/magic-link/verify, which is limited by auth:magic-link-verify (60/60) with issuance at auth:magic-link (3/60); Google is auth:google (10/60). §4's 'rate limiting on login' is met by that pair, not by this entry. DO NOT DELETE: src/scripts/check-log-secrets.mjs asserts this key exists.",
  "sign:bulk-send-create": "No src/modules/sign exists in this repository.",
  "ai:vision": "No route references it.",
};

describe("rate limiting is targeted, not ambient — and the targeting is enforced", () => {
  const tiers = declaredTiers();
  const handlers = publicWriteHandlers();

  it("finds enough handlers that a broken scan cannot pass vacuously", () => {
    expect(tiers.length).toBeGreaterThan(90);
    expect(handlers.length).toBeGreaterThan(20);
    expect(handlers.every((handler) => /^.+:(Post|Put|Patch|Delete) /.test(handler.id))).toBe(true);
    expect(new Set(handlers.map((handler) => handler.id)).size).toBe(handlers.length);
  });

  it("RateLimitGuard is deliberately not an APP_GUARD, and admission is the ambient layer", () => {
    const appModule = readFileSync(resolve(CONTROLLER_ROOT, "app.module.ts"), "utf8");
    const globalGuards = [...appModule.matchAll(/APP_GUARD,\s*useClass:\s*(\w+)/g)].map(
      (match) => match[1],
    );

    expect(globalGuards).not.toContain("RateLimitGuard");
    expect(globalGuards).toContain("AdmissionGuard");

    const guard = readFileSync(join(__dirname, "rate-limit.guard.ts"), "utf8");
    expect(guard).toContain("if (!tier) return true;");
  });

  it("every unauthenticated write is rate-limited, or is a named gap with an owner", () => {
    const unlimited: string[] = [];

    for (const handler of handlers) {
      const decorated = handler.decorators.includes("@UseRateLimit(");
      const inline = tiers.some((tier) => handler.body.includes(`"${tier}"`));
      if (decorated || inline) continue;
      unlimited.push(handler.id);
    }

    expect(unlimited.sort()).toEqual(Object.keys(UNLIMITED_PUBLIC_WRITES).sort());
  });

  it("keeps the gap map SHRINK-ONLY — a new unlimited public write cannot be appended", () => {
    for (const declared of Object.keys(UNLIMITED_PUBLIC_WRITES))
      expect([declared, EVER_RECORDED_AS_UNLIMITED.includes(declared)]).toEqual([declared, true]);
    expect(Object.keys(UNLIMITED_PUBLIC_WRITES)).toHaveLength(
      EVER_RECORDED_AS_UNLIMITED.length - Object.keys(CLOSED_PUBLIC_WRITE_GAPS).length,
    );
  });

  it("closed each named gap by wiring a real tier, not by deleting the entry", () => {
    for (const [id, tier] of Object.entries(CLOSED_PUBLIC_WRITE_GAPS)) {
      expect([id, tiers.includes(tier)]).toEqual([id, true]);
      const handler = handlers.find((candidate) => candidate.id === id);
      expect([id, handler !== undefined]).toEqual([id, true]);
      expect([id, handler?.decorators.includes(`@UseRateLimit("${tier}")`)]).toEqual([id, true]);
      expect([id, handler?.decorators.includes("RateLimitGuard")]).toEqual([id, true]);
      expect([id, id in UNLIMITED_PUBLIC_WRITES]).toEqual([id, false]);
    }
  });

  it("names no gap that has since been closed or moved", () => {
    const identities = new Set(handlers.map((handler) => handler.id));
    for (const declared of Object.keys(UNLIMITED_PUBLIC_WRITES))
      expect(identities.has(declared)).toBe(true);
  });

  it("declares no tier that no route can reach, beyond the recorded ones", () => {
    const sources = controllerFiles(CONTROLLER_ROOT)
      .concat(serviceLikeFiles(CONTROLLER_ROOT))
      .filter((file) => !file.endsWith("rate-limit.service.ts"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    const unreachable = tiers.filter((tier) => !sources.includes(`"${tier}"`));
    expect(unreachable.sort()).toEqual(Object.keys(TIERS_WITH_NO_ROUTE).sort());
  });
});

function serviceLikeFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) serviceLikeFiles(full, found);
    else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) found.push(full);
  }
  return found;
}

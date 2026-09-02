import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isScopable } from "src/modules/rbac/permissions";
import { BACKEND_ROOT, loadRouteSurface } from "./route-surface";

/**
 * A scope gate that cannot bite is worse than no gate: it reads as a control in
 * review and admits everyone at runtime. Two shapes are covered here.
 *
 *  1. A resolver that falls back to `"all"` when its key is not marked
 *     `scopable` in the catalog. `isScopable` is then permanently false, the
 *     resolver returns `"all"` for every caller, and `applyScope("all", …)`
 *     degrades to `sql\`true\``. The gate is inert and looks present.
 *  2. A widening filter gated on a boolean "holds the key at all" rather than on
 *     the key's DataScope, which collapses `own` and `team` into `all`.
 */

const SCOPE_HELPER_DIRS = join(BACKEND_ROOT, "src", "modules");

/** `if (!isScopable(SOME_PERMISSION)) return "all";` — and the key it names. */
const FAIL_OPEN_RE = /if\s*\(\s*!\s*isScopable\s*\(\s*([\w.]+)\s*\)\s*\)\s*return\s*["']all["']/g;
const CONST_KEY_RE = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*["'`]([^"'`]+)["'`]/g;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) yield full;
  }
}

export interface FailOpenSite {
  readonly file: string;
  readonly permissionKey: string;
  readonly scopable: boolean;
}

function findFailOpenResolvers(): FailOpenSite[] {
  const sites: FailOpenSite[] = [];
  for (const abs of walk(SCOPE_HELPER_DIRS)) {
    const source = readFileSync(abs, "utf8");
    if (!source.includes("isScopable")) continue;
    const constants = new Map<string, string>();
    for (const m of source.matchAll(CONST_KEY_RE)) constants.set(m[1] as string, m[2] as string);
    for (const m of source.matchAll(FAIL_OPEN_RE)) {
      const permissionKey = constants.get(m[1] as string);
      if (!permissionKey) continue;
      sites.push({
        file: abs.slice(BACKEND_ROOT.length + 1).replace(/\\/g, "/"),
        permissionKey,
        scopable: isScopable(permissionKey),
      });
    }
  }
  return sites;
}

/**
 * Resolvers whose key is not scopable, so the fallback is live and every caller
 * resolves `"all"`. Named rather than counted, because each needs either a
 * `scopable: true` catalog entry or a fail-closed fallback, and the two choices
 * are not interchangeable.
 */
const KNOWN_LIVE_FAIL_OPEN: ReadonlyMap<string, string> = new Map([
  [
    "src/modules/goals/goals-scope.ts",
    "build:goals:manage is not scopable, so resolveGoalsScope returns 'all' for every caller",
  ],
  [
    "src/modules/hr/directory/assets-scope.ts",
    "hr:assets:manage is not scopable, so resolveAssetsScope returns 'all' for every caller",
  ],
]);

describe("BOLA sweep — a scope gate must be able to bite", () => {
  const sites = findFailOpenResolvers();

  it("ANTI-VACUITY: the scan finds the fail-open fallback in real resolvers", () => {
    expect(sites.length).toBeGreaterThan(8);
    expect(sites.some((s) => s.scopable)).toBe(true);
  });

  it("NO-NEW-FAIL-OPEN: every fail-open resolver names a key the catalog marks scopable", () => {
    const live = sites
      .filter((s) => !s.scopable)
      .filter((s) => !KNOWN_LIVE_FAIL_OPEN.has(s.file))
      .map((s) => `${s.file} → ${s.permissionKey}`);
    expect(live).toEqual([]);
  });

  it("RATCHET: the live fail-open list does not grow", () => {
    const live = sites.filter((s) => !s.scopable).map((s) => s.file);
    expect(new Set(live).size).toBeLessThanOrEqual(KNOWN_LIVE_FAIL_OPEN.size);
  });

  it("PINNED: each known fail-open resolver is still resolving 'all' for everyone", () => {
    for (const [file] of KNOWN_LIVE_FAIL_OPEN) {
      const site = sites.find((s) => s.file === file);
      if (!site) continue;
      expect(isScopable(site.permissionKey)).toBe(false);
    }
  });
});

describe("BOLA sweep — a widening filter is gated on DataScope, not on holding the key", () => {
  /**
   * `GET /tasks` widens on `crm:tasks:view !== "none"`. That key IS scopable, so
   * a caller narrowed to `own` or `team` passes the gate, the owner predicate is
   * dropped entirely, and `?assigneeId=<anyone>` returns that person's tasks.
   * The read key `tasks:read` is an employee-self-service default, so every
   * active member reaches the route.
   */
  it("KNOWN-OPEN crm/tasks: the widening gate collapses own and team into all", () => {
    const source = readFileSync(
      join(BACKEND_ROOT, "src/modules/tasks/tasks.service.ts"),
      "utf8",
    );
    expect(source).toContain('resolved.get("crm:tasks:view")');
    expect(isScopable("crm:tasks:view")).toBe(true);

    const gatesOnAll =
      source.includes('resolved.get("crm:tasks:view") ?? "none") === "all"') ||
      source.includes('=== "all"');
    expect(gatesOnAll).toBe(false);
    expect(source).toContain('!== "none"');
  });
});

describe("BOLA sweep — realtime capability is tenant-checked at grant time", () => {
  const read = (rel: string): string => readFileSync(join(BACKEND_ROOT, rel), "utf8");

  it("no minting endpoint accepts a client-supplied channel name or resource id", () => {
    const minting = loadRouteSurface().filter(
      (r) =>
        r.path === "/chat/ably-token" ||
        r.path === "/support/ably-token" ||
        r.path === "/notifications/events/token",
    );
    expect(minting).toHaveLength(3);
    for (const route of minting) {
      expect(route.signature).not.toContain("@Param");
      expect(route.signature).not.toContain("@Query");
      expect(route.signature).not.toContain("@Body");
    }
  });

  it("chat: the channel list comes from a membership query, not from the request", () => {
    const source = read("src/modules/chat/chat-realtime.controller.ts");
    expect(source).toMatch(/listMemberChannelIds\s*\(\s*u\.orgId\s*,\s*u\.userId\s*\)/);
    expect(read("src/modules/chat/chat-channel-list.service.ts")).toContain(
      "eq(chatChannels.orgId, orgId)",
    );
  });

  /**
   * The support minting path is the one with real conditional logic — wildcard
   * for `all`, one channel per visible ticket otherwise — and the pre-existing
   * `bola-realtime-channel-scope.spec.ts` does not cover it at all.
   */
  it("support: the grant is built from the caller's DataScope and an org-bound query", () => {
    const source = read("src/modules/support/core/support-realtime.service.ts");
    expect(source).toContain("resolveSupportTicketsViewScope(this.access, u)");
    expect(source).toContain("eq(supportTickets.orgId, u.orgId)");
    expect(source).toMatch(/scope === "none"[\s\S]{0,200}ticketIds: \[\]/);
    expect(source).toContain("MAX_SCOPED_CHANNELS");
  });

  it("every capability channel name is pinned to the caller's own organization", () => {
    const source = read("src/modules/realtime/ably.service.ts");
    const capabilityKeys = [...source.matchAll(/["'`]([a-z-]+:\$\{orgId\}[^"'`]*)["'`]/g)];
    expect(capabilityKeys.length).toBeGreaterThan(0);
    for (const key of capabilityKeys) expect(key[1]).toContain("${orgId}");
  });
});

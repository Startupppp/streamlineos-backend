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
// ADR 0005: a resolver returns `ScopedRead.of(..., "all")` now, not the bare word.
const FAIL_OPEN_RE = /if\s*\(\s*!\s*isScopable\s*\(\s*([\w.]+)\s*\)\s*\)\s*return\s+[^;]*["']all["']/g;
const CONST_KEY_RE = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*["'`]([^"'`]+)["'`]/g;

/**
 * Comments are not code. A doc comment that quotes the fallback it removed would
 * otherwise read as the fallback still being there — which is exactly what the
 * four repaired resolvers now carry.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

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
    const source = withoutComments(readFileSync(abs, "utf8"));
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
 * resolves `"all"`.
 *
 * This list is now EMPTY. `goals-scope.ts` (`build:goals:manage`),
 * `assets-scope.ts` (`hr:assets:manage`) and both resolvers in
 * `dashboard-scope.ts` dropped the fallback entirely and let
 * `resolved.get(KEY) ?? "none"` decide, which fails closed: a holder keeps their
 * grant's own scope and a non-holder is denied. The map stays as the shape a new
 * one would have to be added to, and the assertions below refuse to let it grow.
 */
const KNOWN_LIVE_FAIL_OPEN: ReadonlyMap<string, string> = new Map<string, string>();

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

  it("FIXED: no resolver falls open on a key the catalog does not mark scopable", () => {
    expect(sites.filter((s) => !s.scopable).map((s) => s.file)).toEqual([]);
  });

  /**
   * The four repaired resolvers must not merely have lost the `isScopable`
   * fallback — dropping the branch and returning `"all"` unconditionally would
   * also empty the scan above while being strictly worse. Each has to end at the
   * resolved grant, so a non-holder gets `none`: either `resolved.get(KEY) ??
   * "none"` directly, or `access.scopeFor`, which answers `none` for a
   * non-holder itself.
   */
  it("FIXED: each repaired resolver now fails closed on the caller's own grant", () => {
    const repaired = [
      "src/modules/goals/goals-scope.ts",
      "src/modules/hr/directory/assets-scope.ts",
      "src/modules/dashboard/dashboard-scope.ts",
      "src/modules/tasks/tasks-scope.ts",
    ];
    for (const rel of repaired) {
      const source = withoutComments(readFileSync(join(BACKEND_ROOT, rel), "utf8"));
      expect(source).not.toMatch(new RegExp(FAIL_OPEN_RE.source));
      const failsClosed =
        source.includes('?? "none"') || source.includes("access.scopeFor(u,");
      expect({ rel, failsClosed }).toEqual({ rel, failsClosed: true });
    }
  });
});

describe("BOLA sweep — a widening filter is gated on DataScope, not on holding the key", () => {
  /**
   * `GET /tasks` used to widen on `crm:tasks:view !== "none"`. That key IS
   * scopable, so a caller narrowed to `own` or `team` passed the gate, the owner
   * predicate was dropped entirely, and `?assigneeId=<anyone>` returned that
   * person's tasks — a gate that was present and did not bite. The read key
   * `tasks:read` is an employee-self-service default, so every active member
   * reached the route.
   *
   * The assertion is inverted rather than deleted. It used to pin the defect,
   * which means it could not go green and stay honest; as a regression guard it
   * fails if the gate is ever loosened back to a presence check.
   */
  it("FIXED crm/tasks: the widening gate resolves the key's DataScope and demands 'all'", () => {
    const service = withoutComments(
      readFileSync(join(BACKEND_ROOT, "src/modules/tasks/tasks.service.ts"), "utf8"),
    );
    const scope = withoutComments(
      readFileSync(join(BACKEND_ROOT, "src/modules/tasks/tasks-scope.ts"), "utf8"),
    );
    expect(isScopable("crm:tasks:view")).toBe(true);
    expect(scope).toContain('resolved.get(TASKS_VIEW_PERMISSION) ?? "none"');
    /*
     * ADR 0005 replaced the `if (!canViewAll)` branch with an AND: the requested
     * assignee filter goes into the same scoped spec as the owner predicate, so at
     * `own` the WHERE is `assignee = requested AND assignee = actor` and the
     * widening cannot take effect. `tasks-assignee-widening.spec.ts` proves it runs.
     */
    expect(service).toContain("resolvedAssigneeId ? eq(tasks.assigneeId, resolvedAssigneeId) : undefined");
    expect(service).toContain("scope: { columns: { ownerColumn: tasks.assigneeId } }");
    expect(service).not.toContain('!== "none"');
  });

  /**
   * `GET /timesheets/billing/rate-preview` took an optional `userId` and
   * resolved another member's billable rate with no gate at all. It cannot be
   * gated on its own key — `timesheets:billing:view` is not scopable, so testing
   * it would resolve `all` for every holder, which is precisely the no-op the
   * constitution names. It is gated on `timesheets:team:view`, the scopable key
   * every other timesheets read uses for the same parameter.
   */
  it("FIXED timesheets/rate-preview: the userId widening resolves a scopable key's DataScope", () => {
    const scope = withoutComments(
      readFileSync(join(BACKEND_ROOT, "src/modules/timesheets/core/timesheets-core-scope.ts"), "utf8"),
    );
    const controller = withoutComments(
      readFileSync(join(BACKEND_ROOT, "src/modules/timesheets/core/billing.controller.ts"), "utf8"),
    );
    const service = withoutComments(
      readFileSync(join(BACKEND_ROOT, "src/modules/timesheets/core/billing.service.ts"), "utf8"),
    );
    expect(isScopable("timesheets:billing:view")).toBe(false);
    expect(isScopable("timesheets:team:view")).toBe(true);
    expect(scope).toContain("resolveRatePreviewSubject");
    expect(scope).toContain("resolveEntriesScope(access, u)");
    expect(scope).toContain("return read.unrestricted ? requestedUserId : u.userId;");
    expect(controller).toContain("resolveRatePreviewSubject(this.access, u, query.userId)");
    expect(service).not.toContain("query.userId");
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
    // ADR 0005: the tenant predicate is a required field of the scoped read, and `none` returns [] without querying.
    expect(source).toContain("tenant: supportTickets.orgId");
    expect(source).toMatch(/read\.read\([\s\S]{0,400}\(\) => \[\]/);
    expect(source).toContain("MAX_SCOPED_CHANNELS");
  });

  it("every capability channel name is pinned to the caller's own organization", () => {
    const source = read("src/modules/realtime/ably.service.ts");
    const capabilityKeys = [...source.matchAll(/["'`]([a-z-]+:\$\{orgId\}[^"'`]*)["'`]/g)];
    expect(capabilityKeys.length).toBeGreaterThan(0);
    for (const key of capabilityKeys) expect(key[1]).toContain("${orgId}");
  });
});

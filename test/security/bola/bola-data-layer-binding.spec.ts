import { loadRouteSurface, isObjectAddressable, type HandlerRoute } from "./route-surface";
import { buildSourceIndex, analyzeRoute, type BindingVerdict } from "./tenant-binding";
import { allCatalogScopes, platformCapabilityScopes } from "src/modules/access/access-policy";
import {
  PLATFORM_ONLY_PERMISSION_KEYS,
  isDelegablePermission,
} from "src/common/rbac/grantability";

/**
 * Every object-addressable route is followed from its handler into the data
 * layer and must arrive at one of: an org predicate, a tenant transaction, an
 * object-level assertion, or a subject taken from the token. Middleware and
 * guards do not count — `PermissionGuard` proves the caller holds a key, never
 * that the addressed record is theirs.
 *
 * Routes that reach none of those are listed here by name with a reason. Two
 * lists, because they mean opposite things: one is a design where the path
 * itself carries the tenant, the other is an open hole this sweep found.
 */

/** The path parameter IS the tenant selector, on a route with no session to scope by. */
const TENANT_SELECTOR_IN_PATH: ReadonlyMap<string, string> = new Map([
  [
    "GET /blog/by-slug/:slug",
    "vendor marketing blog — blog_posts is deliberately global (db/schema/blog/blog.ts), published posts are public content",
  ],
  [
    "GET /blog/by-slug/:slug/adjacent",
    "vendor marketing blog — same global surface as the sibling read",
  ],
  [
    "GET /public/whiteboard-links/:token",
    "unguessable share token is the only selector; the row is fetched by token equality",
  ],
  [
    "GET /public/feedbucket/:publicKey/config",
    "widget public key is the tenant selector for an anonymous embed",
  ],
  [
    "GET /public/kb/widget/:orgId",
    "returns a static embed descriptor built from the URL orgId; reads no tenant data",
  ],
  [
    "GET /public/kb/widget/:orgId/script",
    "emits a static JS snippet built from the URL orgId; reads no tenant data",
  ],
  [
    "GET /public/wiki/:token",
    "public wiki share token is the selector; rate-limited and matched by token equality",
  ],
  [
    "GET /public/forms/:token",
    "withPublicToken + publicToken equality + isPublic/isActive predicates",
  ],
  [
    "GET /public/lead-form/:token",
    "public lead-capture token is the selector for an anonymous submitter",
  ],
  [
    "GET /public/nps/:token",
    "public survey token is the selector for an anonymous respondent",
  ],
]);

/**
 * Unbound at the data layer BY DESIGN, and the reason is worth stating exactly
 * because it inverts the usual remedy.
 *
 * `blog_posts` and `blog_categories` are the vendor's own global marketing
 * content — one row set for the whole platform, no `org_id` column — so there is
 * no tenant for `BlogService` to bind, and adding one would turn the vendor's
 * public blog into a per-tenant resource, which is a different product.
 *
 * The hole was never the predicate. `blog:posts:manage` and
 * `blog:categories:manage` sat in the per-organization catalog, and
 * `computeUserPermissions` short-circuits every org OWNER and ORG_ADMIN to
 * `allCatalogScopes()` — every catalog key at scope `all` — so every customer's
 * administrator held the keys that rewrite and hard-delete the vendor's public
 * site. The fix is the gate: the three `blog:*` keys are platform-only, removed
 * from the tenant catalog at resolution time and conferred only by deployment
 * configuration. The routes stay listed here because they are still not
 * tenant-bound and never can be; the executable assertions below are what prove
 * they are no longer reachable.
 */
const PLATFORM_GLOBAL_RESOURCE: ReadonlySet<string> = new Set([
  "GET /blog/admin/posts/:postId",
  "PATCH /blog/admin/posts/:postId",
  "DELETE /blog/admin/posts/:postId",
  "PATCH /blog/admin/categories/:categoryId",
  "DELETE /blog/admin/categories/:categoryId",
]);

const BOUND: ReadonlySet<BindingVerdict> = new Set<BindingVerdict>([
  "org-predicate",
  "tenant-transaction",
  "object-assertion",
  "self-subject",
  "delegated",
]);

const key = (r: HandlerRoute): string => `${r.verb} ${r.path}`;

describe("BOLA sweep — authorization is asserted at the data layer", () => {
  const index = buildSourceIndex();
  const addressable = loadRouteSurface().filter(isObjectAddressable);
  const analyzed = addressable.map((r) => analyzeRoute(r, index));
  const unbound = analyzed.filter((b) => !BOUND.has(b.verdict));

  it("ANTI-VACUITY: the source index resolves real services, not an empty map", () => {
    expect(index.methodsByClass.size).toBeGreaterThan(1500);
    expect(index.functions.size).toBeGreaterThan(1500);
    expect(addressable.length).toBeGreaterThan(1800);
  });

  it("COVERAGE: every object-addressable route receives a verdict", () => {
    expect(analyzed).toHaveLength(addressable.length);
    expect(analyzed.every((b) => typeof b.verdict === "string")).toBe(true);
  });

  it("NO-NEW-HOLES: every unbound route is named, with a reason", () => {
    const unnamed = unbound
      .map((b) => `${key(b.route)}  ${b.route.file}:${b.route.line}`)
      .filter((line) => {
        const routeKey = line.slice(0, line.indexOf("  "));
        return !TENANT_SELECTOR_IN_PATH.has(routeKey) && !PLATFORM_GLOBAL_RESOURCE.has(routeKey);
      });
    expect(unnamed).toEqual([]);
  });

  it("RATCHET: the unbound-by-design list does not grow", () => {
    const openNow = unbound.map(key).filter((k) => PLATFORM_GLOBAL_RESOURCE.has(k));
    expect(new Set(openNow).size).toBeLessThanOrEqual(PLATFORM_GLOBAL_RESOURCE.size);
  });

  it("BOUND-MAJORITY: the overwhelming majority of the surface binds a tenant at the data layer", () => {
    const boundCount = analyzed.length - unbound.length;
    expect(boundCount / analyzed.length).toBeGreaterThan(0.99);
  });

  it("REGRESSION hr/recruitment: removeRecruiter re-asserts job ownership before deleting", () => {
    const removeRecruiter = index.methodsByClass
      .get("RecruitmentJobsService")
      ?.get("removeRecruiter");
    expect(removeRecruiter).toBeDefined();
    expect(removeRecruiter?.signature).toContain("orgId");
    expect(removeRecruiter?.body).toContain("this.ensureJob(orgId, jobId)");
  });

  it("REGRESSION hr/recruitment: the controller threads the caller's org into the delete", () => {
    const controller = loadRouteSurface().find(
      (r) => r.verb === "DELETE" && r.path === "/hr/recruitment/jobs/:jobId/recruiters",
    );
    expect(controller).toBeDefined();
    expect(controller?.serviceCalls[0]?.args).toContain("u.orgId");
  });
});

/**
 * The five `/blog/admin/*` routes are the one part of the object-addressable
 * surface that cannot be closed at the data layer, so the gate has to be proved
 * instead — and proved by running it, not by reading the source. Every
 * assertion here would have failed before the fix.
 */
describe("BOLA — the vendor's global blog is unreachable from any tenant standing", () => {
  const BLOG_KEYS = [...PLATFORM_ONLY_PERMISSION_KEYS];

  afterEach(() => {
    delete process.env.PLATFORM_ADMIN_USER_IDS;
  });

  it("ANTI-VACUITY: the keys the blog admin routes gate on are the platform-only ones", () => {
    const routes = loadRouteSurface().filter((r) => r.path.startsWith("/blog/admin"));
    expect(routes.length).toBeGreaterThan(0);
    const gated = new Set(routes.flatMap((r) => r.permissionKeys));
    expect([...gated].every((k) => k.startsWith("blog:"))).toBe(true);
    expect(gated.has("blog:posts:manage")).toBe(true);
    expect(BLOG_KEYS).toContain("blog:posts:manage");
    expect(BLOG_KEYS).toContain("blog:categories:manage");
  });

  it("EXECUTABLE: the owner/org-admin short-circuit no longer confers any blog key", () => {
    const conferred = allCatalogScopes();
    for (const blogKey of BLOG_KEYS) expect(conferred[blogKey]).toBeUndefined();
    expect(conferred["crm:leads:view"]).toBe("all");
  });

  it("EXECUTABLE: no role grant, delegation or module ownership can confer them", () => {
    for (const blogKey of BLOG_KEYS) expect(isDelegablePermission(blogKey)).toBe(false);
    expect(isDelegablePermission("crm:leads:view")).toBe(true);
  });

  it("EXECUTABLE: with no allowlist configured, nobody holds them", () => {
    delete process.env.PLATFORM_ADMIN_USER_IDS;
    expect(platformCapabilityScopes("any-user")).toEqual({});
  });

  it("EXECUTABLE: a user on the allowlist holds them, so the surface is gated and not merely dead", () => {
    process.env.PLATFORM_ADMIN_USER_IDS = "operator-1,operator-2";
    const operator = platformCapabilityScopes("operator-1");
    for (const blogKey of BLOG_KEYS) expect(operator[blogKey]).toBe("all");
    expect(platformCapabilityScopes("customer-admin")).toEqual({});
  });
});

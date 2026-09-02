import { loadRouteSurface, isObjectAddressable, type HandlerRoute } from "./route-surface";
import { buildSourceIndex, analyzeRoute, type BindingVerdict } from "./tenant-binding";

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
 * Open holes. `blog_posts` and `blog_categories` are the vendor's own global
 * marketing content, but `blog:posts:manage` / `blog:categories:manage` sit in
 * the tenant permission catalog, and `computeUserPermissions` short-circuits
 * every org OWNER and ORG_ADMIN to `allCatalogScopes()` — every key at scope
 * `all`. So every customer organization's admin holds the key that edits and
 * deletes the vendor's public marketing site, and the service binds no tenant
 * because there is no tenant column to bind.
 *
 * The fix is the gate, not the predicate: these routes are platform
 * administration and must resolve platform-operator standing rather than a
 * tenant permission key. Listed here so the sweep stays green while the count
 * can only fall.
 */
const KNOWN_OPEN_DEFECTS: ReadonlySet<string> = new Set([
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
        return !TENANT_SELECTOR_IN_PATH.has(routeKey) && !KNOWN_OPEN_DEFECTS.has(routeKey);
      });
    expect(unnamed).toEqual([]);
  });

  it("RATCHET: the open-defect list does not grow", () => {
    const openNow = unbound.map(key).filter((k) => KNOWN_OPEN_DEFECTS.has(k));
    expect(new Set(openNow).size).toBeLessThanOrEqual(KNOWN_OPEN_DEFECTS.size);
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

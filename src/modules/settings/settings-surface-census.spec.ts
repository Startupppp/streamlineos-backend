import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { RequestMethod } from "@nestjs/common";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { REQUIRE_PERMISSION } from "../access/require-permission.decorator";

/**
 * The census behind ticket 19's Settings box.
 *
 * `settings-route-gates.spec.ts` asserts a great deal about the routes that
 * MOVED, but it can only see controllers it imports by name — so it is blind to
 * a controller mounted at `settings/*` from somewhere else in the tree. That
 * blind spot is not hypothetical: three global-settings routes
 * (`POST /settings/automations/:ruleId/test` in `modules/automation`, and the
 * two `/settings/email-templates/*` routes in `modules/email`) survived three
 * inventory passes of this box uncounted, because every pass enumerated
 * `SettingsController` and stopped.
 *
 * This walks the whole of `src/`, finds every controller whose prefix is
 * `settings` or `settings/...`, and reflects its real Nest metadata — not a
 * regex over the source. Each route must appear in `GLOBAL_SETTINGS_SURFACE`
 * with an explicit verdict, so adding one is a decision somebody records rather
 * than a placement nobody notices.
 *
 * THE CRITERION. A route belongs at a global `/settings/*` path iff BOTH hold:
 *
 *   (a) its subject is the ORGANISATION ITSELF or the ACCESS GRAPH over it —
 *       the org's profile and structure, its people as principals, the roles,
 *       grants and delegations that bind them, the modules it has enabled, its
 *       plan, and the audit of those decisions; or it is the VIEWER'S OWN
 *       PRINCIPAL (profile, password, MFA, personal tokens), which
 *       `frontend/CLAUDE.md` §17 names as universal at `/settings`; AND
 *   (b) it is CONFIGURATION or GOVERNANCE — it changes the rules under which
 *       work happens; it is not the work.
 *
 * Three falsifiable corollaries, each of which has already caught something:
 *
 *   OWNERSHIP  If exactly one module owns the rows the route reads and writes,
 *              the route is that module's. `custom_field_definitions` filtered
 *              to `lead|deal|contact` was CRM's; `git_connections.project_id`
 *              is Build's. Both moved on this test.
 *   RUNG       If the intended user must be handed a `settings:*` key to reach
 *              a surface their own module owns, the key is misnamed and so is
 *              the path. A `BUILD_MODULE_ADMIN` needing `settings:manage` to
 *              open Build's git integrations was the symptom.
 *   OPERATION  If the content changes as WORK happens rather than as POLICY
 *              changes, it is operational. `/settings/ai-usage` moved on this
 *              test: usage is a meter reading.
 */

type Verdict =
  /** Organisation configuration: (a) org subject + (b) configuration. */
  | "ORG-CONFIG"
  /** Access governance: roles, grants, delegations, principals, their audit. */
  | "ACCESS-GOVERNANCE"
  /** The viewer's own principal — universal at `/settings` per frontend §17. */
  | "SELF"
  /** A dated alias for a route that has already moved to its owning module. */
  | "SUNSET-ALIAS"
  /** Fails the criterion and has not moved yet. `why` must name the owner. */
  | "PENDING-MOVE";

interface SurfaceEntry {
  verdict: Verdict;
  why: string;
}

const GLOBAL_SETTINGS_SURFACE: Readonly<Record<string, SurfaceEntry>> = {
  "GET /settings/provenance": {
    verdict: "ORG-CONFIG",
    why: "who last changed each organisation-settings section, on organizations.settings",
  },
  "GET /settings/permissions": {
    verdict: "ACCESS-GOVERNANCE",
    why: "the permission catalogue. DUPLICATE of GET /rbac/permissions, which returns the same PERMISSIONS constant behind settings:rbac:manage while this one sits behind the far more widely held settings:view, and no frontend calls it. Static product data, so not a tenant leak — but a second door with a weaker key",
  },
  "GET /settings/api-keys": {
    verdict: "ORG-CONFIG",
    why: "organisation-wide machine credentials. No frontend caller: API-only surface",
  },
  "POST /settings/api-keys": {
    verdict: "ORG-CONFIG",
    why: "organisation-wide machine credentials. No frontend caller: API-only surface",
  },
  "DELETE /settings/api-keys/:keyId": {
    verdict: "ORG-CONFIG",
    why: "organisation-wide machine credentials. No frontend caller: API-only surface",
  },
  "GET /settings/feature-flags": {
    verdict: "ORG-CONFIG",
    why: "organizations.settings.features — org configuration by definition",
  },
  "PATCH /settings/feature-flags": {
    verdict: "ORG-CONFIG",
    why: "organizations.settings.features — org configuration by definition",
  },

  /*
   * R-12. Seven routes, not the six every earlier pass counted: the seventh is
   * on AutomationController in modules/automation and this census is what found
   * it. 48 triggers across HR 27 / CRM 8 / Support 7 / Accounting 6 plus four
   * support-only actions, so no single module rung fits and one was not
   * invented. Four costed options in reports/19b-automations-rung-decision.md.
   * The frontend pages ALREADY live in module trees
   * (/crm|/support|/accounting|/hr .../settings/automations); it is only the
   * backend path and the settings:automations:* key that are global.
   */
  "GET /settings/automations": {
    verdict: "PENDING-MOVE",
    why: "R-12 product decision: no single owning module (HR/CRM/Support/Accounting)",
  },
  "POST /settings/automations": {
    verdict: "PENDING-MOVE",
    why: "R-12 product decision: no single owning module (HR/CRM/Support/Accounting)",
  },
  "GET /settings/automations/:ruleId": {
    verdict: "PENDING-MOVE",
    why: "R-12 product decision: no single owning module (HR/CRM/Support/Accounting)",
  },
  "PATCH /settings/automations/:ruleId": {
    verdict: "PENDING-MOVE",
    why: "R-12 product decision: no single owning module (HR/CRM/Support/Accounting)",
  },
  "DELETE /settings/automations/:ruleId": {
    verdict: "PENDING-MOVE",
    why: "R-12 product decision: no single owning module (HR/CRM/Support/Accounting)",
  },
  "GET /settings/automations/:ruleId/runs": {
    verdict: "PENDING-MOVE",
    why: "R-12 product decision: no single owning module (HR/CRM/Support/Accounting). Also OPERATION — a run log is work, not policy",
  },
  "POST /settings/automations/:ruleId/test": {
    verdict: "PENDING-MOVE",
    why: "R-12 product decision: no single owning module (HR/CRM/Support/Accounting). Lives on AutomationController in modules/automation, which is why the six-route count in report 19b is short by one. Also OPERATION — firing a rule is work",
  },

  /*
   * Owner: the email module. Both fail (a): the subject is the platform's
   * transactional templates, not this organisation. POST .../test also fails
   * (b) — sending a message is work — and takes NO orgId and NO @CurrentUser,
   * so it renders a platform template and sends it to an arbitrary address from
   * the platform's sender with no tenant scoping, no rate limit and no audit.
   * settings:email-templates:manage is carried by the HR_ADMIN role template,
   * so this is reachable by a seeded rung. No tenant data crosses (the
   * templates are static), so it is an abusable send, not a BOLA.
   */
  "GET /settings/email-templates/preview": {
    verdict: "PENDING-MOVE",
    why: "owner: modules/email — platform transactional templates are not organisation configuration",
  },
  "POST /settings/email-templates/test": {
    verdict: "PENDING-MOVE",
    why: "owner: modules/email — unscoped send: no orgId, no @CurrentUser, no rate limit; operational, not configuration",
  },

  "GET /settings/ai-usage": {
    verdict: "SUNSET-ALIAS",
    why: "moved to GET /ai/usage",
  },
  "GET /settings/integrations/git": {
    verdict: "SUNSET-ALIAS",
    why: "moved to GET /integrations/git/connections",
  },
  "POST /settings/integrations/git": {
    verdict: "SUNSET-ALIAS",
    why: "moved to POST /integrations/git/connections",
  },
  "PATCH /settings/integrations/git/:connectionId": {
    verdict: "SUNSET-ALIAS",
    why: "moved to PATCH /integrations/git/connections/:connectionId",
  },
  "DELETE /settings/integrations/git/:connectionId": {
    verdict: "SUNSET-ALIAS",
    why: "moved to DELETE /integrations/git/connections/:connectionId",
  },
  "POST /settings/users/:userId/role": {
    verdict: "SUNSET-ALIAS",
    why: "moved to PATCH /organization/members/:memberId",
  },
  "GET /settings/custom-fields": {
    verdict: "SUNSET-ALIAS",
    why: "moved to GET /crm/settings/custom-fields",
  },
  "POST /settings/custom-fields": {
    verdict: "SUNSET-ALIAS",
    why: "moved to POST /crm/settings/custom-fields",
  },
  "PATCH /settings/custom-fields/:fieldId": {
    verdict: "SUNSET-ALIAS",
    why: "moved to PATCH /crm/settings/custom-fields/:fieldId",
  },
  "DELETE /settings/custom-fields/:fieldId": {
    verdict: "SUNSET-ALIAS",
    why: "moved to DELETE /crm/settings/custom-fields/:fieldId",
  },
};

const SRC_ROOT = resolve(__dirname, "..", "..");

/** Floors. A census that finds nothing must fail, not report a clean tree. */
const MIN_CONTROLLERS = 3;
const MIN_ROUTES = 20;

const METHOD_NAMES: Readonly<Record<number, string>> = {
  [RequestMethod.GET]: "GET",
  [RequestMethod.POST]: "POST",
  [RequestMethod.PUT]: "PUT",
  [RequestMethod.DELETE]: "DELETE",
  [RequestMethod.PATCH]: "PATCH",
};

function controllerFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) controllerFiles(full, found);
    else if (full.endsWith(".controller.ts")) found.push(full);
  }
  return found;
}

interface CensusRoute {
  signature: string;
  file: string;
  permission: string | undefined;
}

function census(): { routes: CensusRoute[]; controllers: Set<string> } {
  const routes: CensusRoute[] = [];
  const controllers = new Set<string>();

  for (const file of controllerFiles(SRC_ROOT)) {
    // Cheap textual pre-filter; the enumeration below is exact Nest metadata.
    if (!/@Controller\(\s*"settings(\/[^"]*)?"/.test(readFileSync(file, "utf8")))
      continue;

    const moduleExports = require(file) as Record<string, unknown>;
    for (const exported of Object.values(moduleExports)) {
      if (typeof exported !== "function") continue;
      const prefix = Reflect.getMetadata(PATH_METADATA, exported) as
        | string
        | undefined;
      if (prefix === undefined || !/^settings(\/|$)/.test(prefix)) continue;

      controllers.add(file);
      const proto = (exported as { prototype: object }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === "constructor") continue;
        const handler = (proto as Record<string, unknown>)[name];
        if (typeof handler !== "function") continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as
          | number
          | undefined;
        if (method === undefined) continue;
        const sub = (Reflect.getMetadata(PATH_METADATA, handler) as string) ?? "";
        const path = ["settings", prefix.slice("settings".length).replace(/^\//, ""), sub]
          .filter((segment) => segment.length > 0)
          .join("/");
        routes.push({
          signature: `${METHOD_NAMES[method] ?? String(method)} /${path}`,
          file: file.slice(SRC_ROOT.length + 1),
          permission: Reflect.getMetadata(REQUIRE_PERMISSION, handler) as
            | string
            | undefined,
        });
      }
    }
  }
  return { routes, controllers };
}

const { routes, controllers } = census();

describe("every route at a global /settings path is inventoried", () => {
  it("finds controllers and routes at all — the census is not vacuous", () => {
    expect(controllers.size).toBeGreaterThanOrEqual(MIN_CONTROLLERS);
    expect(routes.length).toBeGreaterThanOrEqual(MIN_ROUTES);
  });

  it("has an explicit verdict for every route mounted at /settings", () => {
    const uninventoried = routes
      .filter((route) => GLOBAL_SETTINGS_SURFACE[route.signature] === undefined)
      .map((route) => `${route.signature}  (${route.file})`);
    expect(uninventoried).toEqual([]);
  });

  it("has no stale inventory entry naming a route that no longer exists", () => {
    const live = new Set(routes.map((route) => route.signature));
    const stale = Object.keys(GLOBAL_SETTINGS_SURFACE).filter(
      (signature) => !live.has(signature),
    );
    expect(stale).toEqual([]);
  });

  it("every route the criterion rejects names its owner or its decision", () => {
    const unexplained = Object.entries(GLOBAL_SETTINGS_SURFACE)
      .filter(([, entry]) => entry.verdict === "PENDING-MOVE")
      .filter(([, entry]) => entry.why.length < 40)
      .map(([signature]) => signature);
    expect(unexplained).toEqual([]);
  });

  it("every route still carries a permission key — the census is not a bypass", () => {
    const ungated = routes
      .filter((route) => route.permission === undefined)
      .map((route) => route.signature);
    expect(ungated).toEqual([]);
  });
});

describe("the box's remaining debt is exactly what the ticket says it is", () => {
  it("nothing outside automations and email templates is pending a move", () => {
    const pending = Object.entries(GLOBAL_SETTINGS_SURFACE)
      .filter(([, entry]) => entry.verdict === "PENDING-MOVE")
      .map(([signature]) => signature)
      .filter(
        (signature) =>
          !signature.includes("/settings/automations") &&
          !signature.includes("/settings/email-templates"),
      );
    expect(pending).toEqual([]);
  });

  it("the automations surface is seven routes, not the six earlier passes counted", () => {
    const automations = routes.filter((route) =>
      route.signature.includes("/settings/automations"),
    );
    expect(automations).toHaveLength(7);
    expect(
      new Set(automations.map((route) => route.file)).size,
    ).toBeGreaterThan(1);
  });

  it("every automations route is on the one global key, so the rung question is one question", () => {
    const keys = new Set(
      routes
        .filter((route) => route.signature.includes("/settings/automations"))
        .map((route) => route.permission),
    );
    expect([...keys].sort()).toEqual([
      "settings:automations:manage",
      "settings:automations:view",
    ]);
  });
});

import type { HandlerRoute } from "../route-surface";
import { pathParamShape, type PathParamShape } from "./body-synthesis";
import { candidateTableNames, objectAddressableRoutes, pathHints, resolveTables, type TableRef } from "./param-tables";

/**
 * The plan a live cross-tenant sweep executes, and the rule that reads its answers.
 *
 * Pure functions only — no database, no HTTP — so the classifier that decides whether a response
 * is a pass, a finding or a leak is unit-testable on its own (`bola-live-probe-plan.spec.ts`) and
 * the seeded runner cannot quietly disagree with it.
 */

/** Path parameters that do not address an object, so no object id can be borrowed for them. */
export const NON_OBJECT_PARAMS: readonly string[] = [
  "moduleKey",
  "providerKey",
  "entityType",
  "resourceType",
  "subjectType",
  "type",
  "kind",
  "slug",
  "token",
  "shareToken",
  "publicToken",
  "code",
  "key",
  "name",
  "period",
  "date",
  "month",
  "year",
  "locale",
  "format",
  "version",
  "action",
  "status",
  "filename",
  "path",
];

/**
 * The same statement as the list above, by suffix.
 *
 * MEASURED: the exact list caught `moduleKey`, `providerKey`, `entityType`, `token` and `slug`, and
 * missed `sourceKey`, `tourKey`, `layoutKey`, `publicKey`, `eventKey`, `itemKey`, `permissionKey`,
 * `optionType`, `collectorToken`, `sessionToken` and `unitKind` — the same kinds of segment under
 * longer names. `resolveTable` then found a table whose name happened to match, the sweep borrowed
 * a real primary key for a parameter no handler resolves, and the handler answered the caller's own
 * data regardless. That is worse than losing coverage: four routes were scored **NO-404** —
 * `PUT /calendar/sources/:sourceKey` and the three `POST /onboarding/tours/:tourKey/*` — for a
 * parameter that names a per-user preference key, not a tenant object.
 *
 * Every occurrence of these suffixes in the tree was read individually before the rule was written;
 * none of them names a row this sweep could borrow.
 */
const NON_OBJECT_PARAM_SUFFIXES: readonly string[] = ["Key", "Type", "Token", "Kind"];

/** Whether a path parameter names something other than a borrowable object id. */
export function isNonObjectParam(param: string): boolean {
  return (
    NON_OBJECT_PARAMS.includes(param) ||
    NON_OBJECT_PARAM_SUFFIXES.some((suffix) => param.length > suffix.length && param.endsWith(suffix))
  );
}

export type ParamBinding =
  | {
      readonly kind: "table";
      readonly param: string;
      /** The best guess. Kept so existing readers of a binding do not have to change. */
      readonly table: TableRef;
      /**
       * Every table this parameter might address, best first, `table` included as the head.
       *
       * A single answer is what this used to carry, and a wrong one was unrecoverable — the control
       * answered 404 and the route was filed unreachable with nothing in the artifact saying the
       * TABLE was the problem. 252 of the previous run's 355 own-tenant control-404s addressed a
       * table holding exactly one row for the tenant, which is the signature of a table picked
       * because it had a row rather than because it was the right one.
       */
      readonly tables: readonly TableRef[];
    }
  | { readonly kind: "org"; readonly param: string }
  | { readonly kind: "user"; readonly param: string }
  | { readonly kind: "unbindable"; readonly param: string; readonly reason: string };

export interface PlannedRoute {
  readonly key: string;
  readonly verb: string;
  readonly path: string;
  readonly file: string;
  readonly handler: string;
  readonly classification: string;
  readonly bindings: readonly ParamBinding[];
  /** Set when at least one parameter could not be bound; the route is never scored. */
  readonly unprobeable: string | null;
}

export function routeKey(route: HandlerRoute): string {
  return `${route.verb} ${route.path} [${route.controllerClass}.${route.handler}]`;
}

const INTEGER_KEYS: readonly string[] = ["int2", "int4", "int8", "numeric"];

/**
 * Whether a table's primary key can even be spelled the way this route's parameter is declared.
 *
 * A table is dropped only when the contract is explicit AND the key type contradicts it. An unknown
 * key type (the offline specs build `TableRef`s by hand) and an unconstrained parameter both keep
 * every candidate, so the filter can lose coverage in no case it does not already lose.
 */
export function keyFitsParam(table: TableRef, shape: PathParamShape): boolean {
  if (shape === "unconstrained" || table.pkType === undefined) return true;
  if (shape === "integer") return INTEGER_KEYS.includes(table.pkType);
  return table.pkType === "uuid" || table.pkType === "text" || table.pkType === "varchar";
}

export function bindParam(
  route: HandlerRoute,
  param: string,
  known: ReadonlyMap<string, TableRef>,
  populated: ReadonlySet<string>,
): ParamBinding {
  if (param === "orgId" || param === "organizationId") return { kind: "org", param };
  if (param === "userId" || param === "actorId") return { kind: "user", param };
  if (isNonObjectParam(param))
    return { kind: "unbindable", param, reason: `":${param}" does not address an object` };
  const candidates = candidateTableNames(route, param);
  const shape = pathParamShape(route.verb, route.path, param);
  const tables = resolveTables(candidates, known, populated, pathHints(route.path)).filter((table) =>
    keyFitsParam(table, shape),
  );
  const head = tables[0];
  if (!head)
    return {
      kind: "unbindable",
      param,
      reason: `no table resolves ":${param}" (tried ${candidates.slice(0, 4).map((c) => c.name).join(", ")})`,
    };
  const best = tables.find((table) => populated.has(`${table.schema}.${table.name}`));
  if (!best)
    return {
      kind: "unbindable",
      param,
      reason:
        `${head.schema}.${head.name} holds no row for the source tenant` +
        (tables.length > 1 ? ` (nor do ${tables.slice(1).map((t) => `${t.schema}.${t.name}`).join(", ")})` : ""),
    };
  /**
   * The whole ranked list is carried, empty tables included, and `table` is the best POPULATED one.
   *
   * An empty table costs nothing to keep: the borrow pool answers null for it and the sweep moves to
   * the next candidate without spending a request. It has to be kept, because the highest-ranked
   * table is often the right one AND empty — `/tasks/:taskId` really does mean `public.tasks`, which
   * holds no row, while `public.lead_tasks` holds one and is wrong — and `unpopulatedTargets` asks
   * the fixture seeder to fill exactly that case.
   */
  return { kind: "table", param, table: best, tables };
}

export function planRoutes(
  known: ReadonlyMap<string, TableRef>,
  populated: ReadonlySet<string>,
  routes: readonly HandlerRoute[] = objectAddressableRoutes(),
): PlannedRoute[] {
  return routes.map((route) => {
    const bindings = route.pathParams.map((param) => bindParam(route, param, known, populated));
    const blocked = bindings.filter((b): b is Extract<ParamBinding, { kind: "unbindable" }> => b.kind === "unbindable");
    return {
      key: routeKey(route),
      verb: route.verb,
      path: route.path,
      file: route.file,
      handler: `${route.controllerClass}.${route.handler}`,
      classification: route.classification,
      bindings,
      unprobeable: blocked.length === 0 ? null : blocked.map((b) => b.reason).join("; "),
    };
  });
}

/**
 * The tables a route needs and the tenant does not hold — the seeder's work list, best guess first.
 *
 * Returned as `schema.table` -> how many object-addressable routes want it, so a run can spend its
 * fixture budget where it buys the most coverage. In the previous full run 242 routes were blocked
 * on 64 such tables and the top five accounted for 106 of them.
 *
 * It reports the BEST-RANKED table whenever that table is empty, not only when every candidate is.
 * A route whose right table is empty while a wrong one holds a row is the harder case, not the
 * easier one: `/tasks/:taskId` means `public.tasks` (empty) and would otherwise silently bind
 * `public.lead_tasks` (one row, wrong entity) and answer its own tenant 404 forever.
 */
export function unpopulatedTargets(
  known: ReadonlyMap<string, TableRef>,
  populated: ReadonlySet<string>,
  routes: readonly HandlerRoute[] = objectAddressableRoutes(),
): Map<string, { readonly table: TableRef; readonly routes: number }> {
  const out = new Map<string, { table: TableRef; routes: number }>();
  for (const route of routes)
    for (const param of route.pathParams) {
      if (isNonObjectParam(param) || param === "orgId" || param === "organizationId") continue;
      if (param === "userId" || param === "actorId") continue;
      const shape = pathParamShape(route.verb, route.path, param);
      const table = resolveTables(candidateTableNames(route, param), known, populated, pathHints(route.path)).filter(
        (candidate) => keyFitsParam(candidate, shape),
      )[0];
      if (!table) continue;
      if (populated.has(`${table.schema}.${table.name}`)) continue;
      const key = `${table.schema}.${table.name}`;
      const seen = out.get(key);
      if (seen) seen.routes += 1;
      else out.set(key, { table, routes: 1 });
    }
  return out;
}

export function buildPath(path: string, values: ReadonlyMap<string, string>): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (whole, param: string) => {
    const value = values.get(param);
    return value === undefined ? whole : encodeURIComponent(value);
  });
}

export type Verdict =
  | "PASS"
  | "LEAK"
  | "EXISTENCE-ORACLE"
  | "NO-404"
  | "SERVER-ERROR"
  | "INCONCLUSIVE"
  | "UNPROBEABLE";

export interface Scored {
  readonly verdict: Verdict;
  readonly detail: string;
}

/**
 * The whole point of the ticket, in one function.
 *
 * A 403 on another organization's id is a FINDING, not a pass: it confirms the record exists and
 * turns the route into an existence oracle. A 2xx is the leak itself. A 5xx is a finding because
 * the handler reached code that assumed the object was the caller's.
 *
 * A route whose OWN-TENANT control did not answer 2xx is never scored. Without that control a 404
 * proves nothing — an unrouteable path, a rejected id format, a missing permission and a correctly
 * bound tenant all produce exactly the same 404, and counting those as passes is how a sweep
 * reports "all green" over a run in which nothing worked.
 */
export function score(controlStatus: number | null, probeStatus: number | null, note = ""): Scored {
  if (controlStatus === null)
    return { verdict: "UNPROBEABLE", detail: note.length > 0 ? note : "no control request was made" };
  if (controlStatus < 200 || controlStatus >= 300)
    return {
      verdict: "UNPROBEABLE",
      detail: `own-tenant control answered ${String(controlStatus)}${note.length > 0 ? ` — ${note}` : ""}`,
    };
  if (probeStatus === null) return { verdict: "UNPROBEABLE", detail: "no cross-tenant probe was made" };
  if (probeStatus === 404) return { verdict: "PASS", detail: "cross-tenant id answered 404" };
  if (probeStatus >= 200 && probeStatus < 300)
    return { verdict: "LEAK", detail: `cross-tenant id answered ${String(probeStatus)} — the object was served` };
  if (probeStatus === 403)
    return {
      verdict: "EXISTENCE-ORACLE",
      detail: "cross-tenant id answered 403 — a 403 confirms the record exists",
    };
  if (probeStatus >= 500)
    return { verdict: "SERVER-ERROR", detail: `cross-tenant id answered ${String(probeStatus)}` };
  return { verdict: "INCONCLUSIVE", detail: `cross-tenant id answered ${String(probeStatus)}` };
}

export const SCORED_VERDICTS: readonly Verdict[] = [
  "PASS",
  "LEAK",
  "EXISTENCE-ORACLE",
  "NO-404",
  "SERVER-ERROR",
  "INCONCLUSIVE",
];

export function isFinding(verdict: Verdict): boolean {
  return (
    verdict === "LEAK" ||
    verdict === "EXISTENCE-ORACLE" ||
    verdict === "NO-404" ||
    verdict === "SERVER-ERROR"
  );
}

/** A verdict that means another organization's data, or its existence, actually crossed. */
export function isDisclosure(verdict: Verdict): boolean {
  return verdict === "LEAK" || verdict === "EXISTENCE-ORACLE";
}

/**
 * Separates a route that SERVED another tenant's object from one that never resolved an object at
 * all — the second control the ticket's assertion needs.
 *
 * A handler that filters by `orgId` but never asserts the path object exists answers 200 with an
 * empty body for another organization's id. Read alone that is a LEAK, and it is not: request the
 * same route with an id that exists in NO organization and it answers 200 with the same empty body.
 * Nothing was disclosed and nothing was confirmed, because the response does not depend on the
 * object at all. It is still a defect — the box requires 404 — so it is recorded as `NO-404` rather
 * than quietly promoted to a pass.
 *
 * The distinction is the whole difference between a P1 and a hygiene item, so the sweep pays for a
 * third request on every finding rather than guessing.
 */
export function disambiguate(scored: Scored, probeStatus: number | null, absentStatus: number | null): Scored {
  if (!isDisclosure(scored.verdict)) return scored;
  if (absentStatus === null) return scored;
  if (absentStatus !== probeStatus) return scored;
  return {
    verdict: "NO-404",
    detail:
      `an id belonging to no organization answers ${String(absentStatus)} too, so the route never ` +
      "resolves the path object — nothing was disclosed, but the required 404 is absent",
  };
}

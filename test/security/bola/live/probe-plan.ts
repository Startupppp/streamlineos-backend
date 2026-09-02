import type { HandlerRoute } from "../route-surface";
import { candidateTableNames, objectAddressableRoutes, pathHints, resolveTable, type TableRef } from "./param-tables";

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

export type ParamBinding =
  | { readonly kind: "table"; readonly param: string; readonly table: TableRef }
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

export function bindParam(
  route: HandlerRoute,
  param: string,
  known: ReadonlyMap<string, TableRef>,
  populated: ReadonlySet<string>,
): ParamBinding {
  if (param === "orgId" || param === "organizationId") return { kind: "org", param };
  if (param === "userId" || param === "actorId") return { kind: "user", param };
  if (NON_OBJECT_PARAMS.includes(param))
    return { kind: "unbindable", param, reason: `":${param}" does not address an object` };
  const candidates = candidateTableNames(route, param);
  const table = resolveTable(candidates, known, populated, pathHints(route.path));
  if (!table)
    return {
      kind: "unbindable",
      param,
      reason: `no table resolves ":${param}" (tried ${candidates.slice(0, 4).join(", ")})`,
    };
  if (!populated.has(`${table.schema}.${table.name}`))
    return {
      kind: "unbindable",
      param,
      reason: `${table.schema}.${table.name} holds no row for the source tenant`,
    };
  return { kind: "table", param, table };
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

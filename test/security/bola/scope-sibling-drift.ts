import { loadRouteSurface, type HandlerRoute } from "./route-surface";
import { buildSourceIndex, resolveInjectedType, type SourceIndex } from "./tenant-binding";

/**
 * The `/deals/export` shape: two handlers gated by the SAME permission key, one
 * resolving the caller's DataScope and the other not. Because the key is the
 * same, every caller of the scoped one can call the unscoped one, so an
 * `own`-scoped member reads the whole organization through the sibling.
 *
 * Comparing siblings by permission key rather than by URL is what makes this
 * detectable: `GET /deals` and `GET /deals/export` share `crm:deals:read`, and
 * the key is the thing the caller actually holds.
 */

// A handler consults the caller's DataScope. ADR 0005 added the ScopedRead vocabulary and removed `viewAll`.
const SCOPE_RESOLUTION_RE =
  /\b(?:resolve[A-Za-z0-9_$]*Scope|readRequestScope|readRequestScopedRead|rbacScope|applyScope|DataScope|ScopedRead|scopeToUserId)\b/;

/** Reading a scope and never spending it is not applying it; `check:scope-boundary` owns that half. */
export function resolvesScope(text: string): boolean {
  return SCOPE_RESOLUTION_RE.test(text);
}

export interface DriftFinding {
  readonly permissionKey: string;
  readonly scoped: readonly string[];
  readonly unscoped: readonly string[];
}

/**
 * A handler's scope evidence is its own body plus the first layer of service it
 * calls: `deals.controller.ts` resolves the scope in the handler, while
 * `work-logs` resolves it inside the service method. Both count.
 *
 * A standalone helper counts too. `billing.controller.ts` calls
 * `resolveRatePreviewSubject`, which resolves the DataScope and returns the
 * subject the caller is allowed to ask about — the same control, named for what
 * it returns rather than for what it reads, and invisible to a scan that only
 * matched `resolve*Scope`. The lookup is by body, not by name, so nothing is
 * credited for being called something reassuring.
 */
export function handlerScopeEvidence(route: HandlerRoute, index: SourceIndex): boolean {
  if (resolvesScope(route.body)) return true;
  for (const call of route.serviceCalls) {
    const className = route.injected.get(call.property);
    if (!className) continue;
    const method = index.methodsByClass.get(className)?.get(call.method);
    if (method && resolvesScope(method.body)) return true;
    if (!method) continue;
    for (const nested of method.body.matchAll(/this\.(\w+)\.(\w+)\s*\(/g)) {
      const nextClass = resolveInjectedType(method.file, nested[1] as string);
      if (!nextClass) continue;
      const nestedMethod = index.methodsByClass.get(nextClass)?.get(nested[2] as string);
      if (nestedMethod && resolvesScope(nestedMethod.body)) return true;
    }
  }
  for (const call of route.body.matchAll(/this\.(\w+)\s*\(/g)) {
    const own = index.methodsByClass.get(route.controllerClass)?.get(call[1] as string);
    if (own && resolvesScope(own.body)) return true;
  }
  for (const call of route.body.matchAll(/(?:^|[^.\w])([a-z][\w$]*)\s*\(/gm)) {
    const helper = index.functions.get(call[1] as string);
    if (helper && resolvesScope(helper.body)) return true;
  }
  return false;
}

const routeKey = (r: HandlerRoute): string => `${r.verb} ${r.path}`;

/**
 * A detail read (`/deals/:dealId`) discloses the one record its id names, which
 * is BOLA's own question and is answered by the data-layer sweep. The disclosure
 * this detector exists for is bulk: a collection, report or export that hands
 * back many rows the caller's scope would have withheld. Path shape separates
 * the two — a collection route does not end in a parameter.
 */
export function isCollectionShaped(route: HandlerRoute): boolean {
  const last = route.path.split("/").filter(Boolean).at(-1) ?? "";
  return !last.startsWith(":");
}

/**
 * Groups every read handler by the permission key it requires and reports the
 * keys where some handlers scope and others do not. Writes are excluded: a
 * mutation does not disclose the rows it does not touch.
 */
export function findScopeSiblingDrift(): DriftFinding[] {
  const index = buildSourceIndex();
  const byKey = new Map<string, { scoped: string[]; unscoped: string[] }>();

  for (const route of loadRouteSurface()) {
    if (route.verb !== "GET") continue;
    if (route.permissionKeys.length !== 1) continue;
    const permissionKey = route.permissionKeys[0] as string;
    let bucket = byKey.get(permissionKey);
    if (!bucket) {
      bucket = { scoped: [], unscoped: [] };
      byKey.set(permissionKey, bucket);
    }
    if (handlerScopeEvidence(route, index)) bucket.scoped.push(routeKey(route));
    else if (isCollectionShaped(route)) bucket.unscoped.push(routeKey(route));
  }

  const findings: DriftFinding[] = [];
  for (const [permissionKey, bucket] of byKey) {
    if (bucket.scoped.length === 0 || bucket.unscoped.length === 0) continue;
    findings.push({
      permissionKey,
      scoped: [...new Set(bucket.scoped)].sort(),
      unscoped: [...new Set(bucket.unscoped)].sort(),
    });
  }
  return findings.sort((a, b) => a.permissionKey.localeCompare(b.permissionKey));
}

import { REPORTING_REGISTRY, type QueryRegistry } from "./compiler/registry";

/**
 * Reporting adds a way to ask. It must not add a right to know.
 *
 * A generic query surface is a permission bypass with a query language attached
 * unless something stops it. `crm:reporting:run` says a person may run reports;
 * it says nothing about *which data*, so on its own it would let anyone holding
 * it total the pipeline they are not allowed to open, or list every party while
 * being denied the parties screen. Reports would become the way to read what you
 * were refused.
 *
 * So running a report requires two keys, not one: the reporting key, and the key
 * that already governs the source's rows everywhere else in the product —
 * `crm:deals:read` for deals, `party:parties:view` for parties. The second is
 * declared on the source in `registry.ts` and asserted against the catalogue by
 * `registry.spec.ts`, so a source cannot ship guarded by a key nobody mints.
 *
 * This lives in its own file, and is a pure function over a set of held keys,
 * for one reason: it is the module's authorisation decision, and it should be
 * testable without a database, a request, or a Nest container. A decision buried
 * in a service method is a decision tested through four layers of mock, which is
 * how a check comes to be asserted rather than verified.
 *
 * Scope is deliberately not consulted. `crm:deals:read` is `scopable`, so a
 * member may hold it as `own` rather than `all` — and this module has no way to
 * express "only rows assigned to me", because the description's filter is the
 * caller's and cannot be trusted to narrow itself. Rather than pretend, the
 * decision below requires the key and `REPORTING_SCOPE_GAP` records, in code,
 * that a narrowed grant is treated as a full one here. See the note there.
 */

/** Held permission keys, as `AccessService.resolveUserPermissions` returns them. */
export type HeldPermissions = ReadonlySet<string>;

export const REPORTING_VIEW = "crm:reporting:view";
export const REPORTING_MANAGE = "crm:reporting:manage";
export const REPORTING_RUN = "crm:reporting:run";

export interface SourceAccessDecision {
  readonly allowed: boolean;
  /** The key that was missing, so the caller is told what to ask for. */
  readonly missing?: string;
}

/**
 * May this caller run a report against this source?
 *
 * Takes the registry as an argument so the specs can decide against a fixture
 * rather than against whatever the product currently exposes — a test that
 * breaks when somebody registers a new source is a test about the wrong thing.
 */
export function decideSourceAccess(
  sourceKey: string,
  held: HeldPermissions,
  registry: QueryRegistry = REPORTING_REGISTRY,
): SourceAccessDecision {
  if (!held.has(REPORTING_RUN)) return { allowed: false, missing: REPORTING_RUN };

  const source = registry.get(sourceKey);
  /**
   * An unregistered source is refused here as well as in the compiler. It would
   * fail there anyway — but this function's answer must not depend on that, or a
   * future caller that checks access without compiling would be checking
   * nothing.
   */
  if (!source) return { allowed: false, missing: undefined };

  if (!held.has(source.requiredPermission))
    return { allowed: false, missing: source.requiredPermission };

  return { allowed: true };
}

/** Which sources this caller could actually run, for the sources endpoint. */
export function readableSources(
  held: HeldPermissions,
  registry: QueryRegistry = REPORTING_REGISTRY,
): string[] {
  return [...registry.keys()].filter((key) => decideSourceAccess(key, held, registry).allowed);
}

/**
 * A gap this module knows about and does not paper over.
 *
 * `crm:deals:read` is `scopable`: a sales rep may hold it as `own`, meaning
 * "deals assigned to me". This module cannot honour that. Narrowing a report to
 * the caller's own rows would mean injecting an ownership predicate into every
 * compiled query, and doing that correctly requires knowing which field carries
 * ownership on each source, what "team" resolves to, and what a grouped
 * aggregate over a narrowed set even means — none of which is decided yet.
 *
 * Rather than implement a narrowing that is right for deals and wrong for
 * activities, `decideSourceAccess` requires the key and ignores the scope. The
 * effect is that a member with `own` scope on deals can total the whole
 * organisation's pipeline through a report.
 *
 * That is a real widening, so it is stated here rather than left to be
 * discovered, and it is asserted by a spec so it cannot change silently.
 *
 * What limits the blast radius is which roles get the key. `crm:reporting:run`
 * does not end in `:view` or `:read`, so `buildModuleMemberPermissionKeys` does
 * not give it to `CRM_MODULE_MEMBER`; only `CRM_MODULE_OWNER` and
 * `CRM_MODULE_ADMIN` are seeded with it, and `scopeForGrant` gives every
 * non-member slug `all` scope anyway. So no *seeded* role pairs this key with a
 * narrowed source grant.
 *
 * An administrator can still build a custom role that does — `run` beside
 * `crm:deals:read` at `own` — and for that role the narrowing is ignored. That
 * case is not prevented, only stated.
 */
/**
 * What this function still does not decide, now that ticket 11 has landed.
 *
 * The first sentence was true when ticket 10 wrote it and is true now:
 * `decideSourceAccess` answers "may you run this source at all" from the key,
 * and never looks at the scope on the grant.
 *
 * The second sentence is no longer true and has been removed rather than left
 * to age. It said that for a narrowly-granted custom role "a report reads the
 * whole organisation". `ReportingService.requesterScope` now resolves the scope
 * on `crm:reporting:run` and hands it to the compiler, which applies it on the
 * way out — so a narrowed grant narrows the rows. Admission and narrowing are
 * two decisions, and this constant now records only the one this function
 * declines to make.
 */
export const REPORTING_SCOPE_GAP =
  "decideSourceAccess requires the source's permission key but ignores its data scope. " +
  "Admission is decided here; narrowing is applied by the compiler from the scope on " +
  "crm:reporting:run — see ReportingService.requesterScope and compiler/scope.ts.";

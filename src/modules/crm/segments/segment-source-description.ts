import type {
  FieldType,
} from "../../reporting/compiler/query-description";
import { REPORTING_REGISTRY, type QueryRegistry } from "../../reporting/compiler/registry";

/** The key that admits reading segments and evaluating them. */
export const SEGMENT_VIEW = "crm:segments:view";
/** The key that admits authoring one. */
export const SEGMENT_MANAGE = "crm:segments:manage";

/** Held permission keys, as `AccessService.resolveUserPermissions` returns them. */
export type HeldPermissions = ReadonlySet<string>;

/**
 * Which registry sources may be segmented, and what a member of each looks like.
 *
 * ## Why only parties
 *
 * A segment is a set of *counterparties* — the organisations and people you can
 * address, target, route or report a book of business against. `deals` and
 * `activities` are in the registry and are deliberately absent here: a saved,
 * named, re-evaluated set of deals is a report, the reporting module already
 * answers it with grouping and totals that this module has no way to express,
 * and adding them would make "segment" and "saved report" two words for the same
 * feature. Keeping this map to one entry now is what stops that, and the map
 * exists — rather than a hardcoded `"parties"` — so that adding the second one
 * is a reviewed line here instead of a rewrite.
 *
 * ## Why the field lists are names and not columns
 *
 * Every string is a registry field name. `compileQuery` resolves each against
 * the source's declared fields and refuses an unknown one, so a typo here is a
 * 400 at evaluation time rather than a column nobody meant to expose. This file
 * never learns a physical column name, which is the property that keeps the
 * registry the single answer to "what is queryable".
 *
 * The first entry is the ordering key, so it must be the field a person reads as
 * the row's identity.
 */
const SEGMENT_MEMBER_FIELDS: Readonly<Record<string, readonly string[]>> = {
  parties: [
    "name",
    "party_type",
    "status",
    "lifecycle_stage",
    "industry",
    "city",
    "owner_user_id",
    "created_at",
  ],
};

/**
 * A `Map` for lookup, for the reason `registry.ts` gives at length.
 *
 * `SEGMENT_MEMBER_FIELDS["__proto__"]` reaches the prototype and is truthy, so a
 * caller-supplied source of `"constructor"` would pass a naive existence check
 * and carry on into the build path with something that is not a field list. A
 * `Map` has no prototype chain to walk, so those names miss like any other
 * unknown name.
 */
export const SEGMENTABLE = new Map<string, readonly string[]>(
  Object.entries(SEGMENT_MEMBER_FIELDS),
);

export const isSegmentableSource = (sourceKey: string): boolean =>
  SEGMENTABLE.has(sourceKey);

export interface SegmentSourceAccessDecision {
  readonly allowed: boolean;
  /**
   * The key that was missing, so the caller is told what to ask for. Absent when
   * the source is not segmentable at all — there is no key that would grant
   * that, so saying "forbidden" would send somebody to an administrator who
   * cannot help.
   */
  readonly missing?: string;
}

/**
 * May this caller read the rows behind this source?
 *
 * The same two-key rule the reporting module states, applied to the segment
 * keys: `crm:segments:view` says a person may work with segments, and says
 * nothing about *which data*. On its own it would make a segment the way to
 * count and list the customers whose screen you are refused — a permission
 * bypass with a saved name attached. So evaluating a segment requires the
 * segment key **and** the key that already governs the source's rows everywhere
 * else in the product, which the registry declares on the source itself
 * (`party:parties:view` for parties).
 *
 * A pure function over a set of held keys, in its own file, for the reason
 * `reporting-source-access.ts` gives: this is the module's authorisation
 * decision and it should be testable without a database, a request or a Nest
 * container. A decision buried in a service method is a decision asserted
 * through four layers of mock rather than verified.
 *
 * The registry is a parameter so the specs can decide against a fixture rather
 * than against whatever the product currently exposes.
 */
export function decideSegmentSourceAccess(
  sourceKey: string,
  held: HeldPermissions,
  registry: QueryRegistry = REPORTING_REGISTRY,
): SegmentSourceAccessDecision {
  if (!held.has(SEGMENT_VIEW)) return { allowed: false, missing: SEGMENT_VIEW };
  if (!SEGMENTABLE.has(sourceKey)) return { allowed: false, missing: undefined };

  const source = registry.get(sourceKey);
  /**
   * Segmentable-but-unregistered cannot happen while both maps are literals in
   * this repository, and is refused anyway. The alternative is falling through
   * to the compiler, which would refuse it too — but then this function's answer
   * would depend on a downstream check, and a future caller that authorises
   * without compiling would be authorising nothing.
   */
  if (!source) return { allowed: false, missing: undefined };

  if (!held.has(source.requiredPermission))
    return { allowed: false, missing: source.requiredPermission };

  return { allowed: true };
}

export interface SegmentSourceField {
  readonly name: string;
  readonly label: string;
  readonly type: FieldType;
}

export interface SegmentSourceDescription {
  readonly key: string;
  readonly label: string;
  /** Every field a criterion may name, base fields and joined ones together. */
  readonly fields: readonly SegmentSourceField[];
}

/**
 * The criteria vocabulary, filtered to what this caller may actually evaluate.
 *
 * Filtered rather than annotated, for the reason `describeSources` gives: a
 * response listing a source with `canRead: false` beside it is a schema
 * disclosure with a flag on it — it tells a caller that parties exist, what
 * their fields are called, and therefore what the tenant stores.
 *
 * Relations are flattened into the one field list rather than nested. The
 * reporting builder keeps them separate because it groups and aggregates across
 * them; a segment only ever *filters*, and `party.industry` is already a usable
 * field name verbatim, so a second level of structure would buy the criteria UI
 * nothing but a nesting to unwrap.
 */
export function describeSegmentSources(
  held: HeldPermissions,
  registry: QueryRegistry = REPORTING_REGISTRY,
): SegmentSourceDescription[] {
  const described: SegmentSourceDescription[] = [];

  for (const key of SEGMENTABLE.keys()) {
    if (!decideSegmentSourceAccess(key, held, registry).allowed) continue;
    const source = registry.get(key);
    if (!source) continue;

    const fields: SegmentSourceField[] = Object.entries(source.fields).map(
      ([name, field]) => ({ name, label: field.label, type: field.type }),
    );

    for (const [relation, join] of Object.entries(source.joins ?? {}))
      for (const [name, field] of Object.entries(join.fields))
        fields.push({
          name: `${relation}.${name}`,
          label: `${field.label} (${relation})`,
          type: field.type,
        });

    described.push({ key, label: source.label, fields });
  }

  return described;
}

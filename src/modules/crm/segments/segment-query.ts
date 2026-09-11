import type {
  FieldType,
  FilterNode,
  QueryDescription,
} from "../../reporting/compiler/query-description";
import { REPORTING_REGISTRY, type QueryRegistry } from "../../reporting/compiler/registry";

/**
 * What a segment is, expressed entirely in the reporting compiler's vocabulary.
 *
 * ## Why this module has no query engine of its own
 *
 * A segment is a saved criteria expression over CRM rows, evaluated on read.
 * Written from scratch that is a filter grammar, a field allow-list, a type
 * table, a parameter binder and a tenant predicate — which is precisely the
 * thing `modules/reporting/compiler` already is, down to the adversarial specs
 * that attack it. A second one would not be a smaller version of the first: it
 * would be a second place where a caller's string can become an identifier, a
 * second answer to "which columns may a tenant ask about", and a second
 * opportunity to forget the organisation predicate. Two query engines is not
 * twice the surface, it is twice the surface plus the drift between them.
 *
 * So there is exactly one engine and this module is a caller of it. Everything
 * dangerous — identifier quoting, parameter binding, the tenant predicate, the
 * requester's `DataScope` — stays where it already has specs. What lives here is
 * the part that is genuinely about segments and about nothing else: which
 * sources may be segmented, what a member row looks like, and how a stored
 * filter is wrapped into a description the compiler will accept.
 *
 * ## What this file may and may not decide
 *
 * It may decide *shape*: which fields a member row projects, how it is ordered,
 * how many come back. It may not decide *reach*. Nothing here names a physical
 * table or column — every string below is a registry field *name*, resolved by
 * `compileQuery` against the registry and refused if it is not there. That
 * boundary is what keeps the reuse honest: a mistake in this file produces a
 * refused compilation, never a widened one.
 *
 * ## Why a segment stores a filter and not a description
 *
 * `QueryDescription` also carries projections, grouping, ordering and a limit.
 * A segment that could store those would be a saved report under a different
 * noun, and the two would immediately diverge — two screens, two permission
 * ladders, one engine, and a permanent argument about which one to extend. The
 * stored artefact is a `FilterNode` and nothing else, so "which rows" is the
 * only question a segment can express, and the shape of the answer belongs to
 * whoever is reading. `buildMemberQuery` and `buildCountQuery` below are the
 * only two shapes there are.
 */

/** The key that admits reading segments and evaluating them. */
export const SEGMENT_VIEW = "crm:segments:view";
/** The key that admits authoring one. */
export const SEGMENT_MANAGE = "crm:segments:manage";

/** Held permission keys, as `AccessService.resolveUserPermissions` returns them. */
export type HeldPermissions = ReadonlySet<string>;

/**
 * How many member rows one evaluation returns, at most.
 *
 * A preview bound rather than a page size, and the difference is the next
 * docblock's subject. 100 matches the platform's list cap so no surface here can
 * ask the database for more than any other list does.
 */
export const SEGMENT_MEMBER_PREVIEW_MAX = 100;

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
const SEGMENTABLE = new Map<string, readonly string[]>(
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

/**
 * Refused because the source cannot be segmented.
 *
 * A named error rather than a `BadRequestException`, so this file stays free of
 * Nest and testable as a pure function. The service maps it.
 */
export class UnsegmentableSourceError extends Error {
  constructor(readonly sourceKey: string) {
    super(`no segmentable source named ${JSON.stringify(sourceKey)}`);
    this.name = "UnsegmentableSourceError";
  }
}

function memberFields(sourceKey: string): readonly string[] {
  const fields = SEGMENTABLE.get(sourceKey);
  if (!fields) throw new UnsegmentableSourceError(sourceKey);
  return fields;
}

/**
 * The rows in a segment, as a description the compiler will accept.
 *
 * ## Why there is a limit but no offset
 *
 * This returns a bounded preview, not a page, and that is a consequence of a
 * deliberate absence in the registry rather than an unfinished paginator. No
 * registry source publishes a row identifier — reporting groups and totals, it
 * does not link — so there is no unique column to order by and therefore no
 * stable cursor. Offering `offset` on top of an ordering that is not unique
 * produces a list that repeats and skips rows between pages the moment anything
 * is written, and on a "who is in this segment" screen that reads as the segment
 * changing under the reader. A refused feature is better than one that lies.
 *
 * What the reader gets instead is a bounded sample *and* an exact count from
 * `buildCountQuery`, which is the number that is always right and the one a
 * segment exists to produce. Paging becomes possible the day a source declares
 * an identifier field, and this is the only place that would change.
 *
 * ## Why the ordering is by the first projected field
 *
 * `SortSpec.select` is an index into `select`, never a field name — the compiler
 * refuses to sort by a column the caller did not project, because repeated
 * queries ordered by an unseen column reconstruct it. Index 0 is the source's
 * identity field by the contract on `SEGMENT_MEMBER_FIELDS`, so the preview is
 * alphabetical by the thing a person reads as the row's name, which is the only
 * ordering that makes a truncated sample legible.
 */
export function buildMemberQuery(
  sourceKey: string,
  criteria: FilterNode,
  limit: number,
): QueryDescription {
  const fields = memberFields(sourceKey);

  return {
    source: sourceKey,
    select: fields.map((field) => ({ kind: "field", field })),
    filter: criteria,
    orderBy: [{ select: 0, direction: "asc" }],
    limit: Math.min(Math.max(limit, 1), SEGMENT_MEMBER_PREVIEW_MAX),
  };
}

/**
 * How many rows are in the segment, right now.
 *
 * `COUNT(*)` over the same filter, through the same compiler, under the same
 * tenant and scope predicates — so the count and the preview can never disagree
 * about what membership means. That is the reason this is a second compiled
 * description rather than `rows.length`: a sample capped at a hundred would
 * report a hundred for a segment of forty thousand, and a size that saturates is
 * worse than no size at all.
 *
 * `limit: 1` because an ungrouped aggregate returns one row and the compiler
 * requires a limit on every description. It is not a bound on what is counted —
 * `LIMIT` applies to the result, and the result is the single total.
 */
export function buildCountQuery(sourceKey: string, criteria: FilterNode): QueryDescription {
  memberFields(sourceKey);

  return {
    source: sourceKey,
    select: [{ kind: "aggregate", aggregate: "count" }],
    filter: criteria,
    limit: 1,
  };
}

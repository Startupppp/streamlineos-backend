import type {
  FilterNode,
  QueryDescription,
} from "../../reporting/compiler/query-description";
import { SEGMENTABLE } from "./segment-source-description";
export type {
  HeldPermissions,
  SegmentSourceAccessDecision,
  SegmentSourceField,
  SegmentSourceDescription,
} from "./segment-source-description";
export {
  SEGMENT_VIEW,
  SEGMENT_MANAGE,
  isSegmentableSource,
  decideSegmentSourceAccess,
  describeSegmentSources,
} from "./segment-source-description";

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

/**
 * How many member rows one evaluation returns, at most.
 *
 * A preview bound rather than a page size, and the difference is the next
 * docblock's subject. 100 matches the platform's list cap so no surface here can
 * ask the database for more than any other list does.
 */
export const SEGMENT_MEMBER_PREVIEW_MAX = 100;

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

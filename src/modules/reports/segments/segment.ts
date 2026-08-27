import { compileQuery, type CompiledQuery, type Requester } from "../query/query-compiler";
import { QueryDescriptionError } from "../query/query-errors";
import type { QueryDescription } from "../query/query-description";
import { entityDefinition } from "../query/query-graph";

/**
 * Which records, said once.
 *
 * Phase 5, ticket 16. The ticket's reason is stated in its own title — "over the
 * same query surface" — and it is worth being explicit about what goes wrong
 * otherwise, because building a separate segment engine is the natural thing to
 * do and it is wrong for reasons that only show up later.
 *
 * A marketing segment and a report are the same question asked for two
 * purposes: which records match these conditions. Built separately, they drift
 * within a quarter. The report says four hundred customers in the north
 * region and the campaign goes to four hundred and twelve, because one of them
 * treats a null region as excluded and the other does not. Nobody can say which
 * is right, because "north region" now has two definitions and neither is
 * written down as the definition.
 *
 * Worse, the second engine is where tenancy gets reimplemented. The reporting
 * compiler cannot be opted out of; a segment engine written by somebody in a
 * hurry has a `WHERE` string in it. And a segment is the one query in the
 * product whose output is used to SEND things to people — so the blast radius of
 * a scoping mistake is not a wrong number on a screen, it is a mail to somebody
 * else's customers.
 *
 * So a segment is a `QueryDescription`. It compiles through `compileQuery`, gets
 * the same tenancy predicate, the same scope, the same bounds and the same
 * exclusion of deleted records, and there is no second path.
 */

/**
 * What a segment may be built over.
 *
 * The ticket names Party, Subject and Activity. `deals` is deliberately absent:
 * a segment's members are things you can send to, and a deal is not a
 * recipient — segmenting on deals and then mailing "the segment" means mailing
 * whoever happens to be attached, which is how a person receives four copies of
 * the same campaign because they have four open deals.
 */
export const SEGMENTABLE_ENTITIES = ["parties", "subjects", "activities"] as const;
export type SegmentableEntity = (typeof SEGMENTABLE_ENTITIES)[number];

/**
 * Whether the segment is a question or an answer.
 *
 * `live` re-evaluates on every use, which is what a segment should be: somebody
 * who stops matching stops receiving. `snapshot` freezes the members at a moment
 * and keeps sending to them.
 *
 * The ticket's second criterion permits a snapshot but insists it be
 * deliberate, and the word is doing work. A frozen list is occasionally
 * correct — an A/B test's control arm has to stay the same people, and a
 * regulatory notice goes to whoever was a customer on the date of the incident.
 * It is also how a segment quietly becomes wrong: the list was built in March,
 * eleven people have opted out since, and none of that is visible in a name like
 * "Active customers".
 *
 * So a snapshot carries the moment it was taken and the reason it was taken,
 * both required. A caller that cannot say why it needs a frozen list usually
 * does not.
 */
export type SegmentEvaluation =
  | { readonly mode: "live" }
  | { readonly mode: "snapshot"; readonly takenAt: Date; readonly because: string };

export interface Segment {
  readonly segmentId: string;
  readonly orgId: string;
  readonly name: string;
  readonly entity: SegmentableEntity;
  /**
   * The same type a report uses. Not a subset, not a superset — a filter
   * expression that is valid here and invalid there is the drift this ticket
   * exists to prevent.
   */
  readonly description: QueryDescription;
  readonly evaluation: SegmentEvaluation;
}

/**
 * A description carrying an entity that is not a recipient, refused early.
 *
 * Refused at construction rather than at send time, because by send time the
 * segment has a name, a campaign attached and somebody's confidence behind it.
 */
export function assertSegmentable(description: QueryDescription): SegmentableEntity {
  const entity = description.entity;
  if (!SEGMENTABLE_ENTITIES.includes(entity as SegmentableEntity))
    throw new QueryDescriptionError(
      `a segment is a set of records you can reach, and "${entity}" is not one — ` +
        `use ${SEGMENTABLE_ENTITIES.join(", ")}`,
    );
  if (!entityDefinition(entity))
    throw new QueryDescriptionError(`"${entity}" is not a reportable entity`);
  return entity as SegmentableEntity;
}

/**
 * The members, compiled for whoever is asking.
 *
 * Third criterion. Not "the compiler is also used" — the ONLY way to get
 * members, so a segment cannot honour tenancy differently from a report because
 * it has no other route to a row.
 */
export function compileMembership(segment: Segment, who: Requester): CompiledQuery {
  assertSegmentable(segment.description);
  return compileQuery(segment.description, who);
}

/**
 * How big it is, before it is used for anything.
 *
 * Fourth criterion. The count is compiled from the SAME description as the
 * membership, with the aggregation swapped in — not from a separate counting
 * query, because a count that comes from a different query is a count of a
 * different thing, and the number a person approves would not be the number that
 * receives the mail.
 *
 * The description's own `limit` is discarded. A segment limited to a hundred rows
 * for display would otherwise report its size as a hundred, which is the most
 * reassuring possible wrong answer to "how many people am I about to email".
 */
export function compileSize(segment: Segment, who: Requester): CompiledQuery {
  assertSegmentable(segment.description);
  const { select: _select, orderBy: _orderBy, limit: _limit, ...rest } = segment.description;
  return compileQuery(
    {
      ...rest,
      aggregations: [{ of: "count", as: "members" }],
      groupBy: undefined,
      /*
        One row, because that is how many an ungrouped COUNT returns. Dropping
        the limit entirely is not enough: the compiler supplies a default of a
        hundred to any description that did not say, and a count query carrying
        `LIMIT 100` invites the next reader to conclude the segment was capped at
        a hundred members. Saying 1 says what is true.
      */
      limit: 1,
    },
    who,
  );
}

export type SendRefusal =
  | { readonly ok: true; readonly size: number }
  | { readonly ok: false; readonly why: string };

/**
 * How large a segment may get before somebody has to look at it.
 *
 * Not a cap on sending — a tenant with fifty thousand customers is entitled to
 * mail fifty thousand customers. It is the size above which a segment is
 * probably not the segment the author thought they built, because the most
 * common mistake in a filter is one that matches everybody: an `isNotNull` on a
 * column that is never null, a `contains` on an empty string.
 */
export const SEGMENT_REVIEW_THRESHOLD = 5_000;

/**
 * Whether a segment may be used to send, given its measured size.
 *
 * A size of zero is refused rather than permitted-and-ignored. Sending to an
 * empty segment does nothing, which sounds harmless, and is how a campaign
 * reports success having reached nobody — the author believes it went out and
 * finds out weeks later that their filter never matched.
 */
export function readyToSend(
  size: number,
  approvedForLargeSend: boolean,
): SendRefusal {
  if (size === 0)
    return {
      ok: false,
      why: "this segment currently matches nobody — check its filters before sending",
    };
  if (size >= SEGMENT_REVIEW_THRESHOLD && !approvedForLargeSend)
    return {
      ok: false,
      why: `this segment matches ${size} records, which needs an explicit confirmation before sending`,
    };
  return { ok: true, size };
}

/**
 * Whether the membership used for a send is still the membership that was
 * approved.
 *
 * A live segment is re-evaluated, which means the size somebody approved and the
 * size at send time can differ — usually by a little, occasionally by a lot when
 * an import lands in between. Rather than freeze the list (which would make
 * every segment a snapshot, defeating the second criterion), the size is
 * re-measured at send time and a material change stops the send for a human.
 *
 * Ten per cent, because smaller drift is the segment doing its job.
 */
export const MATERIAL_DRIFT = 0.1;

export function driftedTooFar(approvedSize: number, sizeNow: number): boolean {
  if (approvedSize === 0) return sizeNow > 0;
  return Math.abs(sizeNow - approvedSize) / approvedSize > MATERIAL_DRIFT;
}

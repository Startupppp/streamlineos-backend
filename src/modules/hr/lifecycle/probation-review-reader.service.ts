import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrEmployments, hrPeople } from "../../../db/schema/hr/core-people";
import { organizationPeople } from "../../../db/schema/directory/organization-people";
import { hrProbationReviews } from "../../../db/schema/hr/probation";
import type { ProbationCoverage } from "./probation-coverage";
import type { ListProbationReviewsInput } from "./dto/probation.schemas";
import {
  decodeProbationListCursor,
  encodeProbationListCursor,
} from "./probation-list-cursor";

/** Probation ending exactly on `onDate` still covers it — the boundary day is inside probation. */
export function probationCoveringPredicate(onDate: string): SQL {
  return sql`${hrProbationReviews.status} IN ('in_probation', 'review_due', 'extended') AND coalesce(${hrProbationReviews.extendedUntil}, ${hrProbationReviews.probationEndDate}) >= ${onDate}`;
}

@Injectable()
export class ProbationReviewReaderService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listDueForReview(orgId: string, query: ListProbationReviewsInput) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() + 7);
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    const effectiveEndDate = sql<string>`coalesce(${hrProbationReviews.extendedUntil}, ${hrProbationReviews.probationEndDate})`;
    const cursor = query.cursor ? decodeProbationListCursor(query.cursor) : null;
    const cursorFilter = cursor
      ? or(
          gt(effectiveEndDate, cursor.effectiveEndDate),
          and(
            eq(effectiveEndDate, cursor.effectiveEndDate),
            gt(hrProbationReviews.id, cursor.probationReviewId),
          ),
        )
      : undefined;

    const rows = await this.db
      .select({
        id: hrProbationReviews.id,
        orgId: hrProbationReviews.orgId,
        employmentId: hrProbationReviews.employmentId,
        personId: hrProbationReviews.personId,
        probationEndDate: hrProbationReviews.probationEndDate,
        status: hrProbationReviews.status,
        extensionCount: hrProbationReviews.extensionCount,
        extendedUntil: hrProbationReviews.extendedUntil,
        confirmedAt: hrProbationReviews.confirmedAt,
        createdAt: hrProbationReviews.createdAt,
        firstName: organizationPeople.firstName,
        lastName: organizationPeople.lastName,
        workEmail: organizationPeople.workEmail,
        effectiveEndDate,
      })
      .from(hrProbationReviews)
      .innerJoin(
        hrPeople,
        and(
          eq(hrPeople.orgId, hrProbationReviews.orgId),
          eq(hrPeople.id, hrProbationReviews.personId),
        ),
      )
      .innerJoin(
        organizationPeople,
        and(
          eq(organizationPeople.organizationId, hrPeople.orgId),
          eq(organizationPeople.organizationPersonId, hrPeople.organizationPersonId),
        ),
      )
      .where(
        and(
          eq(hrProbationReviews.orgId, orgId),
          isNull(hrPeople.deletedAt),
          or(
            eq(hrProbationReviews.status, "review_due"),
            and(
              inArray(hrProbationReviews.status, ["in_probation", "extended"]),
              lte(effectiveEndDate, cutoff),
            ),
          ),
          cursorFilter,
        ),
      )
      .orderBy(asc(effectiveEndDate), asc(hrProbationReviews.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const pageRows = rows.slice(0, query.limit);
    const lastRow = pageRows.at(-1);

    return {
      data: pageRows.map(({ effectiveEndDate: _effectiveEndDate, ...review }) => review),
      pageInfo: {
        limit: query.limit,
        hasMore,
        nextCursor:
          hasMore && lastRow
            ? encodeProbationListCursor({
                effectiveEndDate: lastRow.effectiveEndDate,
                probationReviewId: lastRow.id,
              })
            : null,
      },
    };
  }

  async listDueForSweep(orgId: string) {
    const today = new Date().toISOString().slice(0, 10);
    return this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${orgId}:probation-sweep`}, 0))`,
      );
      const dueReviews = await transaction
        .select({ id: hrProbationReviews.id, personId: hrProbationReviews.personId })
        .from(hrProbationReviews)
        .where(
          and(
            eq(hrProbationReviews.orgId, orgId),
            inArray(hrProbationReviews.status, ["in_probation", "extended"]),
            lte(
              sql<string>`coalesce(${hrProbationReviews.extendedUntil}, ${hrProbationReviews.probationEndDate})`,
              today,
            ),
          ),
        )
        .orderBy(asc(hrProbationReviews.id))
        .limit(100)
        .for("update");
      if (dueReviews.length === 0) return [];

      await transaction
        .update(hrProbationReviews)
        .set({ status: "review_due", updatedAt: new Date() })
        .where(
          and(
            eq(hrProbationReviews.orgId, orgId),
            inArray(
              hrProbationReviews.id,
              dueReviews.map((review) => review.id),
            ),
            inArray(hrProbationReviews.status, ["in_probation", "extended"]),
          ),
        );
      return dueReviews;
    });
  }

  async resolveUserIds(orgId: string, personIds: number[]): Promise<Map<number, string | null>> {
    const people = await this.db
      .select({ id: hrPeople.id, userId: hrPeople.userId })
      .from(hrPeople)
      .where(and(eq(hrPeople.orgId, orgId), inArray(hrPeople.id, [...new Set(personIds)])));
    return new Map(people.map((person) => [person.id, person.userId]));
  }

  async probationCoverageOn(
    orgId: string,
    userId: string,
    onDate: string,
  ): Promise<ProbationCoverage> {
    const [row] = await this.db
      .select({
        reviewCount: sql<number>`count(*)`.mapWith(Number),
        coveringCount: sql<number>`count(*) FILTER (WHERE ${probationCoveringPredicate(onDate)})`.mapWith(
          Number,
        ),
      })
      .from(hrProbationReviews)
      .innerJoin(
        hrEmployments,
        and(
          eq(hrEmployments.id, hrProbationReviews.employmentId),
          eq(hrEmployments.orgId, hrProbationReviews.orgId),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .innerJoin(
        hrPeople,
        and(
          eq(hrPeople.id, hrEmployments.personId),
          eq(hrPeople.orgId, hrProbationReviews.orgId),
          isNull(hrPeople.deletedAt),
        ),
      )
      .where(and(eq(hrProbationReviews.orgId, orgId), eq(hrPeople.userId, userId)));

    if (!row || row.reviewCount === 0) return "no-record";
    return row.coveringCount > 0 ? "on-probation" : "past-probation";
  }
}

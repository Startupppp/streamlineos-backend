import { and, eq, isNull, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { hrEmployments, hrPeople } from "../../../../db/schema/hr/core-people";
import { hrProbationReviews } from "../../../../db/schema/hr/probation";
import { probationCoveringPredicate } from "../probation-review-reader.service";

function buildCoverageQuery(orgId: string, userId: string, onDate: string) {
  const db = drizzle(postgres("postgres://unused:unused@127.0.0.1:1/unused", { max: 1 }));
  return db
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
}

describe("probationCoverageOn compiles to valid SQL", () => {
  const compiled = buildCoverageQuery("org-1", "user-1", "2026-03-01").toSQL();

  it("emits one aggregate row with a FILTER clause rather than a LIMIT 1 existence probe", () => {
    expect(compiled.sql.toLowerCase()).toContain("count(*) filter (where");
    expect(compiled.sql.toLowerCase()).not.toContain("limit");
    expect(compiled.sql.toLowerCase()).not.toContain("group by");
  });

  it("binds the tenant, the subject and the date as parameters, never as literals", () => {
    expect(compiled.params).toEqual(["2026-03-01", "org-1", "user-1"]);
    expect(compiled.sql).not.toContain("org-1");
  });

  it("re-asserts org_id on every joined table rather than leaning on RLS", () => {
    const orgPredicates = compiled.sql.match(/"org_id"/g) ?? [];
    expect(orgPredicates.length).toBeGreaterThanOrEqual(3);
  });

  it("excludes soft-deleted employments and people", () => {
    expect(compiled.sql).toContain('"deleted_at" is null');
  });
});

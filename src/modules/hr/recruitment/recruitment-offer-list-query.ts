import { and, desc, eq, sql } from "drizzle-orm";
import { candidateOffers, candidates, jobPostings } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import type { OfferListInput } from "./dto/candidate-records.schemas";

/**
 * The org-wide offer pipeline read: every open offer across candidates, joined to the
 * candidate and the job posting, keyset-paginated with a total.
 *
 * It is a read model, not part of the offer write lifecycle. Its grain is the org (the
 * write path's is one candidate's offers), its callers are a different controller and the
 * HR hub, and it changes when the list's projection, filters or pagination change —
 * never when an offer's approval or negotiation rules do. The explicit projection is
 * load-bearing (§1: never `select *`, never a raw ORM row), and `org_id` leads the
 * predicate so the keyset index stays usable under RLS (§7).
 */
export async function queryOrgOffers(db: Db, orgId: string, query: OfferListInput) {
  const conditions = [eq(candidateOffers.orgId, orgId)];
  if (query.status) conditions.push(eq(candidateOffers.offerStatus, query.status));
  const baseWhere = and(...conditions);
  const position = decodeCursor(query.cursor);
  if (position) conditions.push(keysetBeforeId(candidateOffers.createdAt, candidateOffers.id, position));
  const where = and(...conditions);

  const [rows, totalRow] = await Promise.all([
    db
      .select({
        id: candidateOffers.id,
        candidateId: candidateOffers.candidateId,
        candidateFirstName: candidates.firstName,
        candidateLastName: candidates.lastName,
        candidateEmail: candidates.email,
        jobPostingId: candidateOffers.jobPostingId,
        jobTitle: jobPostings.title,
        offerStatus: candidateOffers.offerStatus,
        offeredSalary: candidateOffers.offeredSalary,
        offeredDesignation: candidateOffers.offeredDesignation,
        joiningDate: candidateOffers.joiningDate,
        validUntil: candidateOffers.validUntil,
        sentAt: candidateOffers.sentAt,
        respondedAt: candidateOffers.respondedAt,
        createdAt: candidateOffers.createdAt,
      })
      .from(candidateOffers)
      .innerJoin(candidates, eq(candidateOffers.candidateId, candidates.id))
      .leftJoin(jobPostings, eq(candidateOffers.jobPostingId, jobPostings.id))
      .where(where)
      .orderBy(desc(candidateOffers.createdAt), desc(candidateOffers.id))
      .limit(query.pageSize + 1),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(candidateOffers)
      .where(baseWhere)
      .then((totals) => totals[0] ?? { total: 0 }),
  ]);

  const page = buildCursorPage(rows, query.pageSize, (offer) => ({
    sortValue: offer.createdAt.toISOString(),
    id: String(offer.id),
  }));
  return {
    items: page.data,
    total: Number(totalRow.total),
    pagination: page.pagination,
  };
}

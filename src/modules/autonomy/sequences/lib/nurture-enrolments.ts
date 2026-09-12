/**
 * Enrolment: the page of who is in a cadence, putting somebody in, and taking
 * them out by hand.
 *
 * Every view leaves here with its party and deal names resolved — a page in
 * two batched lookups, a single row in two indexed ones — so no caller renders
 * a raw id or goes back for a name one row at a time.
 */
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getPostgresErrorCode } from "../../../../common/db/postgres-error";
import { buildCursorPage, decodeCursor, type CursorPage } from "../../../../common/pagination/cursor";
import { keysetBefore } from "../../../../common/pagination/keyset";
import type { Db } from "../../../../db/drizzle.types";
import { crmNurtureEnrollments, deals } from "../../../../db/schema";
import { partyNamesFor } from "../../../party/party-names";
import type { EnrolInNurtureSequenceInput, ListNurtureEnrollmentsQuery } from "../dto/nurture.schemas";
import type { NurtureEnrollmentView } from "../nurture-sequences.types";
import { countSteps, requireDeal, requireParty, requireSequence } from "./nurture-lookups";

const UNIQUE_VIOLATION = "23505";

export async function listEnrollmentsPage(
  db: Db,
  organizationId: string,
  nurtureSequenceId: string,
  query: ListNurtureEnrollmentsQuery,
): Promise<CursorPage<NurtureEnrollmentView>> {
  await requireSequence(db, organizationId, nurtureSequenceId);
  const position = decodeCursor(query.cursor);

  const rows = await db
    .select({
      nurtureEnrollmentId: crmNurtureEnrollments.nurtureEnrollmentId,
      nurtureSequenceId: crmNurtureEnrollments.nurtureSequenceId,
      partyId: crmNurtureEnrollments.partyId,
      dealId: crmNurtureEnrollments.dealId,
      status: crmNurtureEnrollments.status,
      currentStep: crmNurtureEnrollments.currentStep,
      exitReason: crmNurtureEnrollments.exitReason,
      exitedAt: crmNurtureEnrollments.exitedAt,
      enrolledAt: crmNurtureEnrollments.enrolledAt,
    })
    .from(crmNurtureEnrollments)
    .where(
      and(
        eq(crmNurtureEnrollments.organizationId, organizationId),
        eq(crmNurtureEnrollments.nurtureSequenceId, nurtureSequenceId),
        query.status ? eq(crmNurtureEnrollments.status, query.status) : undefined,
        position
          ? keysetBefore(
              crmNurtureEnrollments.enrolledAt,
              crmNurtureEnrollments.nurtureEnrollmentId,
              position,
            )
          : undefined,
      ),
    )
    .orderBy(
      desc(crmNurtureEnrollments.enrolledAt),
      desc(crmNurtureEnrollments.nurtureEnrollmentId),
    )
    .limit(query.limit + 1);

  /**
   * Two lookups for the whole page, after the keyset read rather than joined
   * into it: a join would multiply nothing here, but it would put two more
   * tables inside the ordering the cursor depends on.
   */
  const [partyNames, dealNames] = await Promise.all([
    partyNamesFor(db, organizationId, rows.map((row) => row.partyId)),
    dealNamesFor(db, organizationId, rows.map((row) => row.dealId)),
  ]);

  const named = rows.map((row) => ({
    ...row,
    partyName: partyNames.get(row.partyId) ?? null,
    dealName: row.dealId === null ? null : (dealNames.get(row.dealId) ?? null),
  }));

  return buildCursorPage(named, query.limit, (row) => ({
    sortValue: row.enrolledAt.toISOString(),
    id: row.nurtureEnrollmentId,
  }));
}

/** Names for one page of enrolments. Soft-deleted deals still have a name. */
async function dealNamesFor(
  db: Db,
  organizationId: string,
  dealIds: readonly (number | null)[],
): Promise<Map<number, string>> {
  const ids = [...new Set(dealIds.filter((id): id is number => id !== null))];
  if (ids.length === 0) return new Map();

  const rows = await db
    .select({ id: deals.id, name: deals.name })
    .from(deals)
    .where(and(eq(deals.orgId, organizationId), inArray(deals.id, ids)));

  return new Map(rows.map((row) => [row.id, row.name]));
}

export async function enrolInSequence(
  db: Db,
  organizationId: string,
  nurtureSequenceId: string,
  enrolledByUserId: string,
  input: EnrolInNurtureSequenceInput,
): Promise<NurtureEnrollmentView> {
  const sequence = await requireSequence(db, organizationId, nurtureSequenceId);

  if (sequence.status !== "active")
    throw new BadRequestException("Activate the sequence before enrolling anybody in it");

  const stepCounts = await countSteps(db, organizationId, [nurtureSequenceId]);
  if ((stepCounts.get(nurtureSequenceId) ?? 0) === 0)
    throw new BadRequestException("This sequence has no steps");

  await requireParty(db, organizationId, input.partyId);
  const dealId = input.dealId === undefined ? null : await requireDeal(db, organizationId, input.dealId);

  try {
    const [enrolled] = await db
      .insert(crmNurtureEnrollments)
      .values({
        organizationId,
        nurtureSequenceId,
        partyId: input.partyId,
        dealId,
        enrolledByUserId,
      })
      .returning({
        nurtureEnrollmentId: crmNurtureEnrollments.nurtureEnrollmentId,
        nurtureSequenceId: crmNurtureEnrollments.nurtureSequenceId,
        partyId: crmNurtureEnrollments.partyId,
        dealId: crmNurtureEnrollments.dealId,
        status: crmNurtureEnrollments.status,
        currentStep: crmNurtureEnrollments.currentStep,
        exitReason: crmNurtureEnrollments.exitReason,
        exitedAt: crmNurtureEnrollments.exitedAt,
        enrolledAt: crmNurtureEnrollments.enrolledAt,
      });

    return withNames(db, organizationId, enrolled);
  } catch (error) {
    /**
     * `uniq_crm_nurture_enrollments_live_party`: one live enrolment per party
     * across the whole tenant, refused here where a person can be told rather
     * than blunted later by the frequency cap.
     */
    if (getPostgresErrorCode(error) === UNIQUE_VIOLATION)
      throw new ConflictException("That customer is already in a nurture sequence");
    throw error;
  }
}

export async function unenrolFromSequence(
  db: Db,
  organizationId: string,
  nurtureSequenceId: string,
  nurtureEnrollmentId: string,
): Promise<NurtureEnrollmentView> {
  const [updated] = await db
    .update(crmNurtureEnrollments)
    .set({ status: "exited", exitReason: "manual-stop", exitedAt: new Date() })
    .where(
      and(
        eq(crmNurtureEnrollments.organizationId, organizationId),
        eq(crmNurtureEnrollments.nurtureSequenceId, nurtureSequenceId),
        eq(crmNurtureEnrollments.nurtureEnrollmentId, nurtureEnrollmentId),
        eq(crmNurtureEnrollments.status, "active"),
      ),
    )
    .returning({
      nurtureEnrollmentId: crmNurtureEnrollments.nurtureEnrollmentId,
      nurtureSequenceId: crmNurtureEnrollments.nurtureSequenceId,
      partyId: crmNurtureEnrollments.partyId,
      dealId: crmNurtureEnrollments.dealId,
      status: crmNurtureEnrollments.status,
      currentStep: crmNurtureEnrollments.currentStep,
      exitReason: crmNurtureEnrollments.exitReason,
      exitedAt: crmNurtureEnrollments.exitedAt,
      enrolledAt: crmNurtureEnrollments.enrolledAt,
    });

  /**
   * 404 rather than 403 or 409, and for a row in another tenant that is the
   * whole point: a 403 on somebody else's identifier confirms it exists.
   * An enrolment that has already stopped reads the same way, which is
   * honest — there is no live enrolment here to stop.
   */
  if (!updated) throw new NotFoundException("No active enrolment to stop");

  return withNames(db, organizationId, updated);
}

/**
 * One enrolment's names. The page read resolves a whole page at once; this is
 * the single-row path, where two indexed lookups are cheaper than making the
 * caller go and find a name it will certainly need.
 */
async function withNames(
  db: Db,
  organizationId: string,
  row: Omit<NurtureEnrollmentView, "partyName" | "dealName">,
): Promise<NurtureEnrollmentView> {
  const [partyNames, dealNames] = await Promise.all([
    partyNamesFor(db, organizationId, [row.partyId]),
    dealNamesFor(db, organizationId, [row.dealId]),
  ]);

  return {
    ...row,
    partyName: partyNames.get(row.partyId) ?? null,
    dealName: row.dealId === null ? null : (dealNames.get(row.dealId) ?? null),
  };
}

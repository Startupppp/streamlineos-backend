import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { businessParties, deals, issueRecords } from "../../../db/schema";
import type { IssueTransitionsService } from "../issue-transitions.service";
import type { CreateIssueInput, UpdateIssueInput } from "../dto/issues.schemas";

/**
 * Filing and editing an issue, task or complaint — the rules a WRITE must
 * satisfy, which are not the rules a read must satisfy.
 *
 * A read in `issues.service.ts` is gated by the caller's view scope: `own`,
 * `team` or `all`, applied as a predicate. A write here is gated by the record's
 * ANCHORS: a complaint must name a party, a deal anchor must come with the party
 * it concerns, and every party and deal named must exist, undeleted, inside the
 * caller's organisation. The two sets never mix — no write consults a view
 * scope, and no read checks an anchor — which is the seam.
 *
 * What stays in the service is the read-back. Both writes end by reading the
 * record through an unconditional predicate rather than the writer's own scope,
 * and that choice (explained on `IssuesService.read`) is a read-side decision, so
 * these functions return an identifier and the service does the reading.
 *
 * `assertAnchors` is the gate both writes share and it is deliberately NOT
 * exported: the only way to reach it is through a write that runs it first.
 */

export interface IssueWriteDeps {
  readonly db: Db;
  readonly transitions: Pick<IssueTransitionsService, "recordOpening">;
}

export async function createIssueRecord(
  deps: IssueWriteDeps,
  organizationId: string,
  userId: string,
  input: CreateIssueInput,
): Promise<string> {
  await assertAnchors(deps, organizationId, input.partyId, input.dealId);

  const [created] = await deps.db
    .insert(issueRecords)
    .values({
      organizationId,
      recordType: input.recordType,
      title: input.title,
      severity: input.severity,
      details: input.details,
      reference: input.reference,
      ownerUserId: input.ownerUserId,
      partyId: input.partyId,
      dealId: input.dealId,
      dueAt: input.dueAt === undefined ? undefined : new Date(input.dueAt),
      createdByUserId: userId,
    })
    .returning({ issueRecordId: issueRecords.issueRecordId });

  if (!created) throw new BadRequestException("Record not created");

  /**
   * The opening row of the ledger, with a null `fromStage` — the same shape
   * `deal_stage_transitions` uses for a deal's first move. Written here rather
   * than left implicit so a record's history starts where the record does; a
   * ledger whose first entry is the second thing that happened cannot say who
   * raised it.
   */
  await deps.transitions.recordOpening(organizationId, created.issueRecordId, {
    kind: "human",
    userId,
  });

  return created.issueRecordId;
}

export async function updateIssueRecord(
  deps: IssueWriteDeps,
  organizationId: string,
  issueRecordId: string,
  input: UpdateIssueInput,
): Promise<void> {
  const [existing] = await deps.db
    .select({
      partyId: issueRecords.partyId,
      dealId: issueRecords.dealId,
      recordType: issueRecords.recordType,
    })
    .from(issueRecords)
    .where(
      and(
        eq(issueRecords.organizationId, organizationId),
        eq(issueRecords.issueRecordId, issueRecordId),
      ),
    )
    .limit(1);
  if (!existing) throw new NotFoundException("Record not found");

  const partyId = input.partyId === undefined ? existing.partyId : input.partyId;
  /**
   * The two anchoring rules re-checked against the record as it will be, not
   * as it was. Clearing a complaint's party is the interesting case: the patch
   * looks innocuous and the resulting row violates criterion 2.
   */
  if (existing.recordType === "complaint" && partyId === null)
    throw new BadRequestException("A complaint must anchor to a party");

  const dealId = input.dealId === undefined ? existing.dealId : input.dealId;
  if (dealId !== null && partyId === null)
    throw new BadRequestException("A deal anchor needs the party it concerns");

  await assertAnchors(
    deps,
    organizationId,
    input.partyId ?? undefined,
    input.dealId ?? undefined,
  );

  await deps.db
    .update(issueRecords)
    .set({
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.severity === undefined ? {} : { severity: input.severity }),
      ...(input.details === undefined ? {} : { details: input.details }),
      ...(input.reference === undefined ? {} : { reference: input.reference }),
      ...(input.ownerUserId === undefined ? {} : { ownerUserId: input.ownerUserId }),
      ...(input.partyId === undefined ? {} : { partyId: input.partyId }),
      ...(input.dealId === undefined ? {} : { dealId: input.dealId }),
      ...(input.dueAt === undefined
        ? {}
        : { dueAt: input.dueAt === null ? null : new Date(input.dueAt) }),
    })
    .where(
      and(
        eq(issueRecords.organizationId, organizationId),
        eq(issueRecords.issueRecordId, issueRecordId),
      ),
    );
}

/**
 * Both anchors verified inside the caller's organisation before they are
 * written.
 *
 * The party's foreign key is the composite tenant key and would refuse a
 * cross-tenant identifier on its own; this exists so the refusal is a 404
 * naming what was missing rather than a 23503 surfacing as a 500. The deal's
 * key is composite too, and the same applies.
 */
async function assertAnchors(
  deps: IssueWriteDeps,
  organizationId: string,
  partyId: string | undefined,
  dealId: number | undefined,
): Promise<void> {
  if (partyId !== undefined) {
    const [party] = await deps.db
      .select({ partyId: businessParties.partyId })
      .from(businessParties)
      .where(
        and(
          eq(businessParties.organizationId, organizationId),
          eq(businessParties.partyId, partyId),
          isNull(businessParties.deletedAt),
        ),
      )
      .limit(1);
    if (!party) throw new NotFoundException("Party not found");
  }

  if (dealId !== undefined) {
    const [deal] = await deps.db
      .select({ id: deals.id })
      .from(deals)
      .where(
        and(eq(deals.orgId, organizationId), eq(deals.id, dealId), isNull(deals.deletedAt)),
      )
      .limit(1);
    if (!deal) throw new NotFoundException("Deal not found");
  }
}

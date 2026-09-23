import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { Db } from "../../db/drizzle.module";
import { feedbucketSubmissions } from "../../db/schema";
import type { AccessService } from "../access/access.service";
import type { ScopedRead } from "../access/scoped-read";
import { feedbucketScope } from "./feedbucket-scope";
import {
  buildSubmissionFilterConditions,
  resolveAssigneeMembershipId,
} from "./feedbucket-submission-filters";
import {
  FEEDBUCKET_BULK_MAX,
  type BulkSubmissionsInput,
} from "./feedbucket.schemas";

export type BulkSubmissionOutcome = "updated" | "deleted" | "skipped";

export interface BulkSubmissionItemResult {
  submissionId: number;
  outcome: BulkSubmissionOutcome;
  reason: "not_found_or_filtered" | null;
}

export interface BulkSubmissionsResult {
  requested: number;
  succeeded: number;
  skipped: number;
  results: BulkSubmissionItemResult[];
}

function reportOutcomes(
  requestedIds: readonly number[],
  appliedIds: readonly number[],
  applied: Exclude<BulkSubmissionOutcome, "skipped">,
): BulkSubmissionsResult {
  const appliedSet = new Set(appliedIds);
  const results = requestedIds.map<BulkSubmissionItemResult>((submissionId) =>
    appliedSet.has(submissionId)
      ? { submissionId, outcome: applied, reason: null }
      : { submissionId, outcome: "skipped", reason: "not_found_or_filtered" },
  );
  return {
    requested: requestedIds.length,
    succeeded: appliedSet.size,
    skipped: requestedIds.length - appliedSet.size,
    results,
  };
}

async function assertActionPermitted(
  access: AccessService,
  actor: CurrentUserContext,
  action: BulkSubmissionsInput["action"],
): Promise<void> {
  if (
    action.type === "assign" &&
    (await access.scopeFor(actor, "feedbucket:submissions:assign")) === "none"
  )
    throw new ForbiddenException("Not authorized to assign submissions");
  if (
    action.type === "delete" &&
    (await access.scopeFor(actor, "feedbucket:submissions:delete")) === "none"
  )
    throw new ForbiddenException("Not authorized to delete submissions");
}

export async function bulkMutateFeedbucketSubmissions(
  db: Db,
  access: AccessService,
  actor: CurrentUserContext,
  read: ScopedRead,
  membershipId: number | null,
  body: BulkSubmissionsInput,
): Promise<BulkSubmissionsResult> {
  const ids = [...new Set(body.submissionIds)].sort((a, b) => a - b);
  if (ids.length === 0 || ids.length > FEEDBUCKET_BULK_MAX)
    throw new BadRequestException(
      `Select between 1 and ${FEEDBUCKET_BULK_MAX} submissions`,
    );

  const { action } = body;
  await assertActionPermitted(access, actor, action);

  let assigneeMembershipId: number | null = null;
  if (action.type === "assign" && action.assigneeId !== null) {
    assigneeMembershipId = await resolveAssigneeMembershipId(
      db,
      actor.orgId,
      action.assigneeId,
    );
    if (assigneeMembershipId === null)
      throw new NotFoundException(
        "Assignee is not an active member of this organization",
      );
  }

  const domain = await buildSubmissionFilterConditions(
    db,
    actor.orgId,
    body.filters ?? {},
  );
  domain.push(inArray(feedbucketSubmissions.id, ids));

  const target = read.compose<SQL | null>(
    {
      tenant: feedbucketSubmissions.orgId,
      scope: feedbucketScope(read.actorId, membershipId),
      and: domain,
    },
    (where) => where.sql,
    () => null,
  );
  if (target === null) return reportOutcomes(ids, [], "updated");

  return db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: feedbucketSubmissions.id })
      .from(feedbucketSubmissions)
      .where(and(target, isNull(feedbucketSubmissions.deletedAt)))
      .orderBy(asc(feedbucketSubmissions.id))
      .limit(FEEDBUCKET_BULK_MAX)
      .for("update");
    const lockedIds = locked.map((row) => row.id);
    if (lockedIds.length === 0)
      return reportOutcomes(
        ids,
        [],
        action.type === "delete" ? "deleted" : "updated",
      );

    const now = new Date();
    const patch: Partial<typeof feedbucketSubmissions.$inferInsert> = {
      updatedAt: now,
    };
    if (action.type === "status") patch.status = action.status;
    if (action.type === "priority") patch.priority = action.priority;
    if (action.type === "assign") patch.assigneeMembershipId = assigneeMembershipId;
    if (action.type === "delete") patch.deletedAt = now;

    const mutated = await tx
      .update(feedbucketSubmissions)
      .set(patch)
      .where(
        and(
          eq(feedbucketSubmissions.orgId, actor.orgId),
          inArray(feedbucketSubmissions.id, lockedIds),
        ),
      )
      .returning({ id: feedbucketSubmissions.id });

    return reportOutcomes(
      ids,
      mutated.map((row) => row.id),
      action.type === "delete" ? "deleted" : "updated",
    );
  });
}

import { and, eq } from "drizzle-orm";
import { organizationMembers, signBulkSendJobs, signBulkSendRows } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { SignAuditService } from "../sign-audit.service";
import type { SignNotificationsService } from "../sign-notifications.service";
import type { SignIntegrationsService } from "../sign-integrations.service";
import type { SignTemplatesService } from "../sign-templates.service";
import type { SignEnvelopesService } from "../sign-envelopes.service";
import type { BulkProcessResult } from "../sign-bulk-send.types";
import { mapRow } from "./bulk-send-rows";

/** The service's own collaborators, which the pass acts through. */
export interface BulkSendPassDeps {
  readonly db: Db;
  readonly audit: SignAuditService;
  readonly notifications: SignNotificationsService;
  readonly templates: SignTemplatesService;
  readonly envelopes: SignEnvelopesService;
  readonly integrations: SignIntegrationsService;
}

/**
 * Tries per row before it is given up on.
 *
 * Three, not one and not unbounded. One would mark a row failed on its first
 * transient hiccup and never look again; unbounded would let a single
 * permanently failing row be retried forever, re-entering the worker beside
 * four hundred and ninety-nine rows that are already done.
 */
const MAX_ROW_ATTEMPTS = 3;

/**
 * The pass over a job's outstanding rows: the body of
 * `SignBulkSendService.processQueuedJob` after it has resolved the job, the
 * sender and the signer role. Every row write commits on its own through
 * `commitRow`, and a job with rows left over ends by throwing from `finishJob`,
 * which is how the outbox is asked to bring the event back.
 */
export async function runBulkSendPass(
  deps: BulkSendPassDeps,
  orgId: string,
  jobId: number,
  job: typeof signBulkSendJobs.$inferSelect,
  actor: Parameters<SignEnvelopesService["send"]>[2],
  roleName: string,
): Promise<BulkProcessResult> {
  await commitRow(deps.db, orgId, () =>
    deps.db
      .update(signBulkSendJobs)
      .set({ status: "running" })
      .where(eq(signBulkSendJobs.id, jobId)),
  );

  const pending = await deps.db
    .select()
    .from(signBulkSendRows)
    .where(and(eq(signBulkSendRows.jobId, jobId), eq(signBulkSendRows.status, "pending")))
    .orderBy(signBulkSendRows.rowNumber);

  const columnMapping = (job.columnMappingJson ?? {}) as Record<string, string>;
  let succeeded = 0;
  let failed = 0;

  for (const stored of pending) {
    /**
     * Counted before the attempt, not after. A row that makes the process
     * die — an unhandled provider error, a container restart mid-send —
     * would otherwise keep its old count and be retried forever, which is
     * exactly the row most likely to keep killing the worker.
     */
    const attempts = stored.attempts + 1;
    /*
      Its own committed transaction, which is what makes the budget real.
      Counting before the attempt only protects the worker if the count
      SURVIVES the pass -- see `commitRow`.
    */
    await commitRow(deps.db, orgId, () =>
      deps.db
        .update(signBulkSendRows)
        .set({ attempts, updatedAt: new Date() })
        .where(eq(signBulkSendRows.id, stored.id)),
    );

    if (attempts > MAX_ROW_ATTEMPTS) {
      await commitRow(deps.db, orgId, () =>
        deps.db
          .update(signBulkSendRows)
          .set({
            status: "failed",
            errorMessage: `Gave up after ${MAX_ROW_ATTEMPTS} attempts`,
            updatedAt: new Date(),
          })
          .where(eq(signBulkSendRows.id, stored.id)),
      );
      failed++;
      continue;
    }

    const row = mapRow(
      stored.rawDataJson as Record<string, unknown>,
      columnMapping,
      stored.rowNumber,
    );
    const name = row.name;
    if (row.error || !name) {
      await commitRow(deps.db, orgId, () =>
        deps.db
          .update(signBulkSendRows)
          .set({ status: "failed", errorMessage: row.error ?? "Missing name", updatedAt: new Date() })
          .where(eq(signBulkSendRows.id, stored.id)),
      );
      failed++;
      continue;
    }

    try {
      /*
       * `outbox` delivery, so the invitation is an outbox row inside this same
       * transaction: `success` below means the envelope is sent AND its
       * invitation is durably queued, or neither happened. An after-commit
       * hook would drain fire-and-forget after `commitRow` returns, and a
       * provider refusal there would leave a `success` row with no invitation
       * behind it and nothing in the error report.
       */
      await commitRow(deps.db, orgId, async () => {
        const envelope = await deps.templates.instantiate(orgId, job.senderMembershipId, job.templateId, {
          recipients: [{ roleName, name, email: row.email, phone: row.phone }],
        });
        await deps.envelopes.send(orgId, envelope.id, actor, "outbox");
        await deps.db
          .update(signBulkSendRows)
          .set({ status: "success", envelopeId: envelope.id, errorMessage: null, updatedAt: new Date() })
          .where(eq(signBulkSendRows.id, stored.id));
      });
      succeeded++;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create envelope";
      /**
       * Left `pending` while the budget lasts, so the next delivery picks it
       * up; marked `failed` only when there is nothing left to try. A row
       * marked failed on its first transient error would never be retried,
       * which is the opposite failure and just as silent.
       */
      const exhausted = attempts >= MAX_ROW_ATTEMPTS;
      await commitRow(deps.db, orgId, () =>
        deps.db
          .update(signBulkSendRows)
          .set({
            status: exhausted ? "failed" : "pending",
            errorMessage: message,
            updatedAt: new Date(),
          })
          .where(eq(signBulkSendRows.id, stored.id)),
      );
      if (exhausted) failed++;
    }
  }

  return finishJob(deps, orgId, jobId, succeeded, failed, pending.length);
}

/**
 * One row's durable state, committed on its own rather than with the pass.
 *
 * **The pass is a transaction, and it is thrown out of on purpose.**
 * `OutboxPublisherService.deliver` wraps `consumer.handle(event)` in
 * `runInNewTenantTransaction`, so everything this job writes joins ONE
 * transaction -- and `finishJob` below ends a partly-done job by THROWING,
 * which is how the outbox is asked to bring the event back. That throw rolls
 * the transaction back.
 *
 * So before this, a pass that sent 400 invitations and had rows left over
 * discarded all 400 `success` rows, all 400 `envelope_id`s and every
 * `attempts` increment -- while the 400 emails stayed sent, because email is
 * not transactional. The retry then re-read the same rows as `pending` with
 * `attempts` unchanged and **sent every one of them again**, forever. The
 * budget that exists to stop a poison row killing the worker could never
 * advance past one, for the same reason.
 *
 * `runInNewTenantTransaction` is the seam that fixes it: it calls
 * `runOutsideTenantContext` first, so this is a genuinely independent
 * transaction on its own connection and not a SAVEPOINT inside the pass. A
 * nested `db.transaction` would have looked identical here and changed
 * nothing.
 *
 * The asymmetry this is all about: emails are irreversible and rows are not,
 * so the row must be at least as durable as the email it describes.
 */
async function commitRow<T>(db: Db, orgId: string, work: () => Promise<T>): Promise<T> {
  return runInNewTenantTransaction(db, orgId, () => work());
}

/** Counts recomputed from the rows, not accumulated, so a resumed job still totals correctly. */
async function finishJob(
  deps: BulkSendPassDeps,
  orgId: string,
  jobId: number,
  succeeded: number,
  failed: number,
  processed: number,
): Promise<BulkProcessResult> {
  const rows = await deps.db
    .select({ status: signBulkSendRows.status })
    .from(signBulkSendRows)
    .where(eq(signBulkSendRows.jobId, jobId));

  const successCount = rows.filter((r) => r.status === "success").length;
  const failedCount = rows.filter((r) => r.status === "failed").length;
  const stillPending = rows.filter((r) => r.status === "pending").length;

  /*
    Committed before the throw below, not with it. The counts are what an
    operator watches a long job through, and rolling them back would leave the
    job reading 0 sent after a pass that sent hundreds.
  */
  await commitRow(deps.db, orgId, () =>
    deps.db
      .update(signBulkSendJobs)
      .set({
        status: stillPending > 0 ? "running" : "completed",
        completedAt: stillPending > 0 ? null : new Date(),
        successCount,
        failedCount,
      })
      .where(eq(signBulkSendJobs.id, jobId)),
  );

  if (stillPending > 0) {
    /** Rows left to try means the event must come back; throwing is how the outbox retries. */
    throw new Error(
      `bulk send job ${jobId}: ${stillPending} row(s) still pending after this pass`,
    );
  }

  const job = await deps.db.query.signBulkSendJobs.findFirst({
    where: and(eq(signBulkSendJobs.id, jobId), eq(signBulkSendJobs.orgId, orgId)),
  });

  await deps.audit.record({
    orgId,
    actorType: "system",
    eventType: "bulk_job_completed",
    eventMessage: `Bulk send job completed: ${successCount} sent, ${failedCount} failed`,
  });

  const senderMember =
    job && job.senderMembershipId != null
      ? await deps.db.query.organizationMembers.findFirst({
          where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.id, job.senderMembershipId)),
          with: { user: { columns: { id: true, name: true, email: true } } },
        })
      : null;
  if (senderMember?.user?.email) {
    await deps.notifications.sendBulkJobCompleted(
      senderMember.user.email,
      senderMember.user.name ?? "there",
      jobId,
      rows.length,
      successCount,
      failedCount,
    );
  }

  deps.integrations.emitBulkSendCompleted(orgId, senderMember?.user?.id ?? null, jobId, {
    totalCount: rows.length,
    successCount,
    failedCount,
  });

  return { jobId, processed, succeeded, failed, skipped: false };
}

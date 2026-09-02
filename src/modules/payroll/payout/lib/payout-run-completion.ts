import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, not, sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import {
  payrollRuns,
  payrollRunEmployees,
  payrollBankBatches,
  payrollBankBatchItems,
  payrollRunEvents,
  organizationMembers,
} from "../../../../db/schema";
import type { AuditService } from "../../../../common/audit/audit.service";
import type { JournalOutboxService } from "../../insights/journal-outbox.service";
import { registerAfterCommit } from "../../../../common/tenant/tenant-context";
import { logSideEffectFailure } from "../../../../common/logger/side-effect";
import { runInNewTenantTransaction } from "../../../../common/tenant";
import { PAYROLL_READ_CAP } from "../../lib/query-bounds";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import { PAYROLL_RUN_PAYOUT_POSTING_INTENT_EVENT } from "../payroll-payout-posting-intent.consumer";

export interface RunCompletionDeps {
  db: Db;
  audit: AuditService;
  journalOutbox?: JournalOutboxService;
  logger: Logger;
}

export async function refreshBatchPaidStatus(db: Db, orgId: string, batchId: number): Promise<void> {
  const rows = await db
    .select({
      status: payrollBankBatchItems.status,
      n: sql<number>`count(*)::int`,
    })
    .from(payrollBankBatchItems)
    .where(
      and(eq(payrollBankBatchItems.batchId, batchId), eq(payrollBankBatchItems.orgId, orgId)),
    )
    .groupBy(payrollBankBatchItems.status);

  let paid = 0;
  let failed = 0;
  let other = 0;
  for (const r of rows) {
    if (r.status === "PAID") paid += r.n;
    else if (r.status === "FAILED") failed += r.n;
    else other += r.n;
  }

  let status: "PAID" | "PARTIALLY_PAID" | "FAILED" | "SENT" | null = null;
  if (other === 0 && failed === 0 && paid > 0) status = "PAID";
  else if (other === 0 && paid === 0 && failed > 0) status = "FAILED";
  else if (paid > 0 || failed > 0) status = "PARTIALLY_PAID";

  if (status) {
    await db
      .update(payrollBankBatches)
      .set({ status })
      .where(and(eq(payrollBankBatches.id, batchId), eq(payrollBankBatches.orgId, orgId)));
  }
}

async function autoSnapshotJournal(
  deps: RunCompletionDeps,
  orgId: string,
  actorId: string,
  periodKey: string,
  runId: number,
): Promise<void> {
  const { journalOutbox } = deps;
  if (!journalOutbox) return;
  try {
    await runInNewTenantTransaction(deps.db, orgId, async () => {
      const batch = await journalOutbox.createBatch(orgId, actorId, {
        periodKey,
        note: `Auto-snapshot after run #${runId} marked paid`,
      });
      deps.logger.log(
        `Journal outbox auto-snapshot batch #${batch.id} v${batch.version} for ${periodKey}`,
      );
      deps.audit.log({
        action: "payroll.journal_batch_auto_created",
        userId: actorId,
        orgId,
        targetId: String(batch.id),
        targetType: "payroll_journal_batch",
        metadata: { periodKey, runId, version: batch.version, status: batch.status },
      });
    });
  } catch (err) {
    deps.logger.error(
      `Journal auto-snapshot failed for ${periodKey}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw err;
  }
}

export async function checkRunCompletion(
  deps: RunCompletionDeps,
  orgId: string,
  batchId: number,
  actorId: string,
): Promise<void> {
  const batch = await deps.db.query.payrollBankBatches.findFirst({
    where: and(eq(payrollBankBatches.id, batchId), eq(payrollBankBatches.orgId, orgId)),
    columns: { runId: true },
  });
  if (!batch) return;

  const runId = batch.runId;

  const allBatches = await deps.db
    .select({ id: payrollBankBatches.id })
    .from(payrollBankBatches)
    .where(and(eq(payrollBankBatches.orgId, orgId), eq(payrollBankBatches.runId, runId)))
    .limit(PAYROLL_READ_CAP + 1);

  const batchIds = allBatches.map(b => b.id);
  if (batchIds.length === 0) return;

  const pendingItems = await deps.db
    .select({ id: payrollBankBatchItems.id })
    .from(payrollBankBatchItems)
    .where(
      and(
        eq(payrollBankBatchItems.orgId, orgId),
        inArray(payrollBankBatchItems.batchId, batchIds),
        not(eq(payrollBankBatchItems.status, "PAID")),
        not(eq(payrollBankBatchItems.status, "FAILED")),
        not(eq(payrollBankBatchItems.status, "HELD")),
      ),
    )
    .limit(1);

  if (pendingItems.length > 0) return;

  const paidRunEmployees = await deps.db
    .select({ runEmployeeId: payrollBankBatchItems.runEmployeeId })
    .from(payrollBankBatchItems)
    .where(
      and(
        eq(payrollBankBatchItems.orgId, orgId),
        inArray(payrollBankBatchItems.batchId, batchIds),
        eq(payrollBankBatchItems.status, "PAID"),
      ),
    )
    .limit(PAYROLL_READ_CAP + 1);

  const paidRunEmployeeIds = paidRunEmployees.map((r) => r.runEmployeeId);

  const paidByMember = await deps.db.query.organizationMembers.findFirst({
    where: and(eq(organizationMembers.userId, actorId), eq(organizationMembers.orgId, orgId)),
    columns: { id: true },
  });
  const paidByMembershipId = paidByMember?.id ?? null;

  const now = new Date();
  let runMarkedPaid = false;
  let paidMonth: string | null = null;

  await deps.db.transaction(async (tx) => {
    const [currentRun] = await tx
      .select({
        status: payrollRuns.status,
        month: payrollRuns.month,
        netTotal: payrollRuns.netTotal,
      })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!currentRun || currentRun.status === "PAID" || currentRun.status === "PAYSLIPS_PUBLISHED" || currentRun.status === "CLOSED") {
      return;
    }

    await tx
      .update(payrollRuns)
      .set({ status: "PAID", paidAt: now, paidBy: actorId, paidByMembershipId })
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)));

    if (paidRunEmployeeIds.length > 0) {
      await tx
        .update(payrollRunEmployees)
        .set({ status: "PAID" })
        .where(
          and(
            eq(payrollRunEmployees.runId, runId),
            eq(payrollRunEmployees.orgId, orgId),
            inArray(payrollRunEmployees.id, paidRunEmployeeIds),
          ),
        );
    }

    await tx.insert(payrollRunEvents).values({
      orgId,
      runId,
      type: "MARKED_PAID",
      actorId,
      metadata: { paidCount: paidRunEmployeeIds.length },
    });

    await OutboxWriter.emit(tx, {
      eventId: randomUUID(),
      organizationId: orgId,
      aggregateType: "payroll_run",
      aggregateId: String(runId),
      aggregateVersion: 2,
      eventType: PAYROLL_RUN_PAYOUT_POSTING_INTENT_EVENT,
      payload: {
        runId,
        month: currentRun.month,
        net: currentRun.netTotal ?? "0",
        actorUserId: actorId,
        orgId,
      },
      occurredAt: now,
    });

    paidMonth = currentRun.month;
    runMarkedPaid = true;
  });

  if (runMarkedPaid && paidMonth) {
    deps.audit.log({
      action: "payroll.marked_paid",
      userId: actorId,
      orgId,
      targetId: String(runId),
      targetType: "payroll_run",
      metadata: { paidCount: paidRunEmployeeIds.length },
    });

    const month = paidMonth;
    const snapshotTask = () =>
      autoSnapshotJournal(deps, orgId, actorId, month, runId).catch(
        logSideEffectFailure("payroll auto-snapshot journal", { orgId, runId }),
      );
    if (!registerAfterCommit(snapshotTask)) void snapshotTask();
  }
}

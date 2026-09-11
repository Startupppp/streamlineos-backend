import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { and, eq, not } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import {
  payrollBankBatches,
  payrollBankBatchItems,
  payrollRunEvents,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { JournalOutboxService } from "../insights/journal-outbox.service";
import { parseBankReturnCsv } from "./lib/bank-return";
import { checkRunCompletion, refreshBatchPaidStatus } from "./lib/payout-run-completion";
import { PAYROLL_READ_CAP, requirePayrollReadWithinCap } from "../lib/query-bounds";

@Injectable()
export class BatchStatusService {
  private readonly logger = new Logger(BatchStatusService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    @Optional() private readonly journalOutbox?: JournalOutboxService,
  ) {}

  private get completionDeps() {
    return {
      db: this.db,
      audit: this.audit,
      journalOutbox: this.journalOutbox,
      logger: this.logger,
    };
  }

  async markSent(orgId: string, batchId: number, actorId: string) {
    const batch = await this.db.query.payrollBankBatches.findFirst({
      where: and(eq(payrollBankBatches.id, batchId), eq(payrollBankBatches.orgId, orgId)),
      columns: { id: true, status: true, runId: true },
    });
    if (!batch) throw new NotFoundException("Batch not found");
    if (batch.status === "SENT") return { success: true };

    if (batch.status !== "GENERATED") {
      throw new ConflictException(
        `Batch must be GENERATED to be marked sent — current status: ${batch.status}`,
      );
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(payrollBankBatches)
        .set({ status: "SENT", sentAt: new Date() })
        .where(and(eq(payrollBankBatches.id, batchId), eq(payrollBankBatches.orgId, orgId)));

      await tx
        .update(payrollBankBatchItems)
        .set({ status: "SENT" })
        .where(
          and(
            eq(payrollBankBatchItems.batchId, batchId),
            eq(payrollBankBatchItems.orgId, orgId),
            eq(payrollBankBatchItems.status, "PENDING"),
          ),
        );

      await tx.insert(payrollRunEvents).values({
        orgId,
        runId: batch.runId,
        type: "BANK_BATCH_SENT",
        actorId,
        metadata: { batchId },
      });
    });

    this.audit.log({
      action: "payroll.bank_batch_sent",
      userId: actorId,
      orgId,
      targetId: String(batch.runId),
      targetType: "payroll_run",
      metadata: { batchId },
    });

    return { success: true };
  }

  async markItemPaid(orgId: string, batchId: number, itemId: number, transactionRef: string, actorId: string) {
    const item = await this.db.query.payrollBankBatchItems.findFirst({
      where: and(
        eq(payrollBankBatchItems.id, itemId),
        eq(payrollBankBatchItems.batchId, batchId),
        eq(payrollBankBatchItems.orgId, orgId),
      ),
    });
    if (!item) throw new NotFoundException("Batch item not found");
    if (item.status === "PAID") throw new ConflictException("Item already marked paid");

    const batchRow = await this.db.query.payrollBankBatches.findFirst({
      where: and(eq(payrollBankBatches.id, batchId), eq(payrollBankBatches.orgId, orgId)),
      columns: { runId: true },
    });

    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(payrollBankBatchItems)
        .set({ status: "PAID", transactionRef, paidAt: now })
        .where(and(eq(payrollBankBatchItems.id, itemId), eq(payrollBankBatchItems.orgId, orgId)));

      if (batchRow?.runId) {
        await tx.insert(payrollRunEvents).values({
          orgId,
          runId: batchRow.runId,
          type: "BANK_ITEM_PAID",
          actorId,
          metadata: { batchId, itemId, transactionRef },
        });
      }
    });

    if (batchRow?.runId) {
      this.audit.log({
        action: "payroll.bank_item_paid",
        userId: actorId,
        orgId,
        targetId: String(batchRow.runId),
        targetType: "payroll_run",
        metadata: { batchId, itemId, transactionRef },
      });
    }

    await refreshBatchPaidStatus(this.db, orgId, batchId);
    await checkRunCompletion(this.completionDeps, orgId, batchId, actorId);
    return { success: true };
  }

  async markItemFailed(orgId: string, batchId: number, itemId: number, failureReason: string, actorId: string) {
    const item = await this.db.query.payrollBankBatchItems.findFirst({
      where: and(
        eq(payrollBankBatchItems.id, itemId),
        eq(payrollBankBatchItems.batchId, batchId),
        eq(payrollBankBatchItems.orgId, orgId),
      ),
    });
    if (!item) throw new NotFoundException("Batch item not found");
    if (item.status === "PAID")
      throw new ConflictException("Item is already paid and cannot be marked failed");

    const batchRow = await this.db.query.payrollBankBatches.findFirst({
      where: and(eq(payrollBankBatches.id, batchId), eq(payrollBankBatches.orgId, orgId)),
      columns: { runId: true },
    });

    await this.db.transaction(async (tx) => {
      await tx
        .update(payrollBankBatchItems)
        .set({ status: "FAILED", failureReason })
        .where(and(eq(payrollBankBatchItems.id, itemId), eq(payrollBankBatchItems.orgId, orgId)));

      if (batchRow?.runId) {
        await tx.insert(payrollRunEvents).values({
          orgId,
          runId: batchRow.runId,
          type: "BANK_ITEM_FAILED",
          actorId,
          metadata: { batchId, itemId, failureReason },
        });
      }
    });

    if (batchRow?.runId) {
      this.audit.log({
        action: "payroll.bank_item_failed",
        userId: actorId,
        orgId,
        targetId: String(batchRow.runId),
        targetType: "payroll_run",
        metadata: { batchId, itemId, failureReason },
      });
    }

    await refreshBatchPaidStatus(this.db, orgId, batchId);
    await checkRunCompletion(this.completionDeps, orgId, batchId, actorId);
    return { success: true };
  }

  async markBatchPaid(orgId: string, batchId: number, transactionRef: string, actorId: string) {
    const batch = await this.db.query.payrollBankBatches.findFirst({
      where: and(eq(payrollBankBatches.id, batchId), eq(payrollBankBatches.orgId, orgId)),
      columns: { id: true, status: true, runId: true },
    });
    if (!batch) throw new NotFoundException("Batch not found");
    if (batch.status === "PAID") return { success: true };

    if (batch.status !== "SENT" && batch.status !== "PARTIALLY_PAID") {
      throw new ConflictException(
        `Batch must be SENT or PARTIALLY_PAID to be marked paid — current status: ${batch.status}`,
      );
    }

    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(payrollBankBatchItems)
        .set({ status: "PAID", transactionRef, paidAt: now })
        .where(
          and(
            eq(payrollBankBatchItems.batchId, batchId),
            eq(payrollBankBatchItems.orgId, orgId),
            not(eq(payrollBankBatchItems.status, "PAID")),
            not(eq(payrollBankBatchItems.status, "FAILED")),
          ),
        );

      const failedItems = await tx
        .select({ id: payrollBankBatchItems.id })
        .from(payrollBankBatchItems)
        .where(
          and(
            eq(payrollBankBatchItems.batchId, batchId),
            eq(payrollBankBatchItems.orgId, orgId),
            eq(payrollBankBatchItems.status, "FAILED"),
          ),
        )
        .limit(1);

      const newBatchStatus = failedItems.length > 0 ? "PARTIALLY_PAID" : "PAID";
      await tx
        .update(payrollBankBatches)
        .set({ status: newBatchStatus })
        .where(and(eq(payrollBankBatches.id, batchId), eq(payrollBankBatches.orgId, orgId)));
    });

    this.audit.log({
      action: "payroll.bank_batch_paid",
      userId: actorId,
      orgId,
      targetId: String(batch.runId),
      targetType: "payroll_run",
      metadata: { batchId, transactionRef },
    });

    await checkRunCompletion(this.completionDeps, orgId, batchId, actorId);
    return { success: true };
  }

  async importBankReturn(orgId: string, batchId: number, actorId: string, csvText: string) {
    const batch = await this.db.query.payrollBankBatches.findFirst({
      where: and(eq(payrollBankBatches.id, batchId), eq(payrollBankBatches.orgId, orgId)),
      columns: { id: true, status: true, runId: true },
    });
    if (!batch) throw new NotFoundException("Batch not found");
    if (batch.status === "GENERATED" || batch.status === "DRAFT") {
      throw new BadRequestException("Mark the batch as sent before importing bank returns");
    }

    const parsed = parseBankReturnCsv(csvText);
    if (parsed.lines.length === 0 && parsed.errors.length > 0) {
      throw new BadRequestException({
        message: "Bank return CSV could not be parsed",
        errors: parsed.errors,
        honestyNote: parsed.honestyNote,
      });
    }

    const items = requirePayrollReadWithinCap(await this.db
      .select({
        id: payrollBankBatchItems.id,
        userId: payrollBankBatchItems.userId,
        status: payrollBankBatchItems.status,
      })
      .from(payrollBankBatchItems)
      .where(and(eq(payrollBankBatchItems.batchId, batchId), eq(payrollBankBatchItems.orgId, orgId)))
      .limit(PAYROLL_READ_CAP + 1), "import bank return items");

    const byId = new Map(items.map((i) => [i.id, i]));
    const byUser = new Map<string, typeof items>();
    for (const it of items) {
      if (!it.userId) continue;
      const list = byUser.get(it.userId) ?? [];
      list.push(it);
      byUser.set(it.userId, list);
    }

    let paid = 0;
    let failed = 0;
    let skipped = 0;
    const applyErrors: { line: number; message: string }[] = [...parsed.errors];

    for (const line of parsed.lines) {
      let target = line.itemId != null ? byId.get(line.itemId) : undefined;
      if (!target && line.userId) {
        const candidates = byUser.get(line.userId) ?? [];
        target = candidates.find((c) => c.status !== "PAID" && c.status !== "FAILED") ?? candidates[0];
      }
      if (!target) {
        applyErrors.push({
          line: line.rawLine,
          message: `No matching item for itemId=${line.itemId ?? "—"} userId=${line.userId ?? "—"}`,
        });
        skipped++;
        continue;
      }
      if (target.status === "PAID" || target.status === "FAILED") {
        skipped++;
        continue;
      }

      if (line.status === "PAID") {
        await this.markItemPaid(orgId, batchId, target.id, line.transactionRef ?? "RETURN", actorId);
        paid++;
      } else {
        await this.markItemFailed(orgId, batchId, target.id, line.failureReason ?? "Bank return failed", actorId);
        failed++;
      }
    }

    await refreshBatchPaidStatus(this.db, orgId, batchId);
    await checkRunCompletion(this.completionDeps, orgId, batchId, actorId);

    this.audit.log({
      action: "payroll.bank_return_imported",
      userId: actorId,
      orgId,
      targetId: String(batch.runId),
      targetType: "payroll_run",
      metadata: { batchId, paid, failed, skipped, errorCount: applyErrors.length },
    });

    return {
      success: true,
      paid,
      failed,
      skipped,
      parseErrors: applyErrors,
      honestyNote: parsed.honestyNote,
      mode: "export_manual" as const,
    };
  }
}

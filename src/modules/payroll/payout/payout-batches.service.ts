import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { and, desc, eq, not } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollRuns,
  payrollRunEmployees,
  payrollBankBatches,
  payrollBankBatchItems,
  payrollRunEvents,
  users,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { StorageService } from "../../storage/storage.service";
import { decryptBankDetails } from "../../../modules/hr/payroll/lib/encryption";
import type { PayoutBatchFormat } from "./dto/payout.schemas";
import { PayrollPostingService } from "../payroll-posting.service";
import { assertOrgMember } from "../lib/org-membership";
import { JournalOutboxService } from "../insights/journal-outbox.service";
import { parseBankReturnCsv } from "./lib/bank-return";
import { defaultFormatFromCurrency, csvHeader, csvRow } from "./lib/payout-csv";
import {
  checkRunCompletion,
  refreshBatchPaidStatus,
} from "./lib/payout-run-completion";

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

@Injectable()
export class PayoutBatchesService {
  private readonly logger = new Logger(PayoutBatchesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly payrollPosting: PayrollPostingService,
    @Optional() private readonly journalOutbox?: JournalOutboxService,
  ) {}

  private get completionDeps() {
    return {
      db: this.db,
      audit: this.audit,
      payrollPosting: this.payrollPosting,
      journalOutbox: this.journalOutbox,
      logger: this.logger,
    };
  }

  async createBatch(
    orgId: string,
    runId: number,
    userId: string,
    idempotencyKey: string | undefined,
    format: PayoutBatchFormat | undefined,
  ) {
    const run = await this.db.query.payrollRuns.findFirst({
      where: and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)),
      columns: { id: true, status: true, month: true },
    });
    if (!run) throw new NotFoundException("Payroll run not found");
    if (run.status !== "APPROVED" && run.status !== "LOCKED") {
      throw new BadRequestException(
        `Cannot generate payout batch for run in status ${run.status} — run must be APPROVED or LOCKED`,
      );
    }

    const employees = await this.db
      .select({
        id: payrollRunEmployees.id,
        userId: payrollRunEmployees.userId,
        net: payrollRunEmployees.net,
        currency: payrollRunEmployees.currency,
        payoutCurrency: payrollRunEmployees.payoutCurrency,
        netPayoutCurrency: payrollRunEmployees.netPayoutCurrency,
        status: payrollRunEmployees.status,
        holdReason: payrollRunEmployees.holdReason,
        bankDetails: users.bankDetails,
        name: users.name,
      })
      .from(payrollRunEmployees)
      .leftJoin(users, eq(payrollRunEmployees.userId, users.id))
      .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId)));

    const alreadyPaidRows = await this.db
      .select({ runEmployeeId: payrollBankBatchItems.runEmployeeId })
      .from(payrollBankBatchItems)
      .innerJoin(payrollBankBatches, eq(payrollBankBatchItems.batchId, payrollBankBatches.id))
      .where(
        and(
          eq(payrollBankBatches.runId, runId),
          eq(payrollBankBatches.orgId, orgId),
          eq(payrollBankBatchItems.status, "PAID"),
        ),
      );
    const alreadyPaidRunEmployeeIds = new Set(alreadyPaidRows.map((r) => r.runEmployeeId));

    const eligible = employees.filter(e => {
      if (alreadyPaidRunEmployeeIds.has(e.id)) return false;
      if (e.status === "HELD" || e.holdReason) return false;
      const bank = decryptBankDetails(e.bankDetails ?? null);
      if (!bank?.accountNumber) return false;
      const net = parseFloat(e.netPayoutCurrency ?? e.net);
      if (net <= 0) return false;
      return true;
    });

    if (eligible.length === 0) {
      throw new BadRequestException("No eligible employees for payout batch — check validation");
    }

    const groupMap = new Map<string, typeof eligible>();
    for (const emp of eligible) {
      const code = emp.payoutCurrency ?? emp.currency;
      const arr = groupMap.get(code) ?? [];
      arr.push(emp);
      groupMap.set(code, arr);
    }

    const month = run.month ?? "unknown";
    const monthNum = month.replace("-", "");
    const narrationLabel = `Salary ${month}`.trim();

    const [seqRow] = await this.db
      .select({ count: payrollBankBatches.id })
      .from(payrollBankBatches)
      .where(and(eq(payrollBankBatches.orgId, orgId), eq(payrollBankBatches.runId, runId)));
    const baseSeq = seqRow?.count ?? 0;

    type ItemData = { runEmployeeId: number; userId: string; amount: string; accountMasked: string; ifsc: string | null };
    type BatchResult = {
      batch: typeof payrollBankBatches.$inferSelect;
      items: Array<typeof payrollBankBatchItems.$inferSelect>;
      fileUrl: string | null;
      currencyCode: string;
      replayed: boolean;
    };

    const results: BatchResult[] = [];
    let groupIdx = 0;

    for (const [currencyCode, groupEmps] of groupMap) {
      const groupFormat: PayoutBatchFormat = format ?? defaultFormatFromCurrency(currencyCode);
      const subKey = idempotencyKey ? `${idempotencyKey}-${currencyCode}` : undefined;

      if (subKey) {
        const existingBatch = await this.db.query.payrollBankBatches.findFirst({
          where: and(
            eq(payrollBankBatches.orgId, orgId),
            eq(payrollBankBatches.idempotencyKey, subKey),
          ),
        });
        if (existingBatch) {
          const batchItems = await this.db.query.payrollBankBatchItems.findMany({
            where: eq(payrollBankBatchItems.batchId, existingBatch.id),
          });
          results.push({ batch: existingBatch, items: batchItems, fileUrl: null, currencyCode, replayed: true });
          groupIdx++;
          continue;
        }
      }

      const csvRows = [csvHeader(groupFormat)];
      const itemsData: ItemData[] = [];

      groupEmps.forEach((emp, idx) => {
        const bank = decryptBankDetails(emp.bankDetails ?? null);
        if (!bank?.accountNumber) return;
        const bankCode = bank.ifsc ?? "";
        const effectiveAmount = emp.netPayoutCurrency ?? emp.net;
        csvRows.push(csvRow(groupFormat, idx + 1, emp.name ?? emp.userId, bank.accountNumber, bankCode, currencyCode, effectiveAmount, narrationLabel));
        itemsData.push({
          runEmployeeId: emp.id,
          userId: emp.userId,
          amount: effectiveAmount,
          accountMasked: "XXXX" + bank.accountNumber.slice(-4),
          ifsc: bankCode || null,
        });
      });

      const csvContent = csvRows.join("\n");
      const csvBuffer = Buffer.from(csvContent, "utf-8");
      const fileName = `payroll-batch-${month}-${currencyCode}-${Date.now()}.csv`;

      const uploadResult = this.storage.isConfigured()
        ? await this.storage.uploadFile(csvBuffer, "payroll/bank-batches", fileName, "text/csv")
        : { url: null as string | null, key: null as string | null };

      const seq = baseSeq + groupIdx + 1;
      const batchNumber = `PAY-${monthNum}-${currencyCode}-${String(seq).padStart(3, "0")}`;
      const totalAmount = itemsData.reduce((s, i) => s + parseFloat(i.amount), 0).toFixed(2);
      const now = new Date();

      let newBatch: typeof payrollBankBatches.$inferSelect | undefined;
      try {
        const [created] = await this.db.transaction(async (tx) => {
          const [batch] = await tx
            .insert(payrollBankBatches)
            .values({
              orgId,
              runId,
              batchNumber,
              status: "GENERATED",
              format: groupFormat,
              totalAmount,
              itemCount: itemsData.length,
              idempotencyKey: subKey ?? null,
              fileKey: uploadResult.key ?? null,
              generatedBy: userId,
              generatedAt: now,
            })
            .returning();

          if (!batch) throw new BadRequestException("Failed to create batch");

          await tx.insert(payrollBankBatchItems).values(
            itemsData.map(item => ({
              orgId,
              batchId: batch.id,
              runEmployeeId: item.runEmployeeId,
              userId: item.userId,
              amount: item.amount,
              accountMasked: item.accountMasked,
              ifsc: item.ifsc,
              status: "PENDING" as const,
            })),
          );

          await tx.insert(payrollRunEvents).values({
            orgId,
            runId,
            type: "BANK_BATCH_GENERATED",
            actorId: userId,
            metadata: {
              batchId: batch.id,
              batchNumber,
              itemCount: itemsData.length,
              totalAmount,
              format: groupFormat,
              currencyCode,
              fileKey: uploadResult.key ?? null,
            },
          });

          return [batch];
        });
        newBatch = created;
      } catch (err: unknown) {
        if (subKey && isDuplicateKeyError(err)) {
          const racedBatch = await this.db.query.payrollBankBatches.findFirst({
            where: and(
              eq(payrollBankBatches.orgId, orgId),
              eq(payrollBankBatches.idempotencyKey, subKey),
            ),
          });
          if (racedBatch) {
            const racedItems = await this.db.query.payrollBankBatchItems.findMany({
              where: eq(payrollBankBatchItems.batchId, racedBatch.id),
            });
            results.push({ batch: racedBatch, items: racedItems, fileUrl: null, currencyCode, replayed: true });
            groupIdx++;
            continue;
          }
        }
        throw err;
      }

      if (!newBatch) {
        throw new InternalServerErrorException("Batch creation returned no row");
      }

      this.audit.log({
        action: "payroll.bank_batch_generated",
        userId,
        orgId,
        targetId: String(runId),
        targetType: "payroll_run",
        metadata: { batchId: newBatch.id, batchNumber, itemCount: itemsData.length, totalAmount, currencyCode },
      });

      const batchItems = await this.db.query.payrollBankBatchItems.findMany({
        where: eq(payrollBankBatchItems.batchId, newBatch.id),
      });

      let fileUrl: string | null = null;
      if (uploadResult.key && this.storage.isConfigured()) {
        try {
          fileUrl = await this.storage.getFileUrl(uploadResult.key, 3600);
        } catch {
          fileUrl = uploadResult.url ?? null;
        }
      }

      results.push({ batch: newBatch, items: batchItems, fileUrl, currencyCode, replayed: false });
      groupIdx++;
    }

    const allReplayed = results.length > 0 && results.every(r => r.replayed);
    const currencies = [...new Set(results.map((r) => r.currencyCode))];
    return {
      batches: results,
      replayed: allReplayed,
      multiCurrency: {
        currencyCount: currencies.length,
        currencies,
        batchCount: results.length,
        honestyNote:
          currencies.length > 1
            ? "One bank export file per payout currency. Amounts use stored netPayoutCurrency/net — this endpoint does not re-apply FX rates at batch time."
            : "Single-currency batch. Amounts use stored netPayoutCurrency/net.",
      },
    };
  }

  async listBatches(orgId: string, runId?: number) {
    const conditions = runId
      ? [eq(payrollBankBatches.orgId, orgId), eq(payrollBankBatches.runId, runId)]
      : [eq(payrollBankBatches.orgId, orgId)];

    return this.db
      .select()
      .from(payrollBankBatches)
      .where(and(...conditions))
      .orderBy(desc(payrollBankBatches.generatedAt))
      .limit(100);
  }

  async getBatch(orgId: string, batchId: number) {
    const batch = await this.db.query.payrollBankBatches.findFirst({
      where: and(eq(payrollBankBatches.id, batchId), eq(payrollBankBatches.orgId, orgId)),
    });
    if (!batch) throw new NotFoundException("Batch not found");

    const items = await this.db.query.payrollBankBatchItems.findMany({
      where: and(eq(payrollBankBatchItems.batchId, batchId), eq(payrollBankBatchItems.orgId, orgId)),
    });

    return { batch, items };
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
          and(eq(payrollBankBatchItems.batchId, batchId), eq(payrollBankBatchItems.orgId, orgId), eq(payrollBankBatchItems.status, "PENDING")),
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
            eq(payrollBankBatchItems.status, "FAILED"),
          ),
        )
        .limit(1);

      const newBatchStatus = failedItems.length > 0 ? "PARTIALLY_PAID" : "PAID";
      await tx
        .update(payrollBankBatches)
        .set({ status: newBatchStatus })
        .where(eq(payrollBankBatches.id, batchId));
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

  async importBankReturn(
    orgId: string,
    batchId: number,
    actorId: string,
    csvText: string,
  ) {
    const batch = await this.db.query.payrollBankBatches.findFirst({
      where: and(eq(payrollBankBatches.id, batchId), eq(payrollBankBatches.orgId, orgId)),
      columns: { id: true, status: true, runId: true },
    });
    if (!batch) throw new NotFoundException("Batch not found");
    if (batch.status === "GENERATED" || batch.status === "DRAFT") {
      throw new BadRequestException(
        "Mark the batch as sent before importing bank returns",
      );
    }

    const parsed = parseBankReturnCsv(csvText);
    if (parsed.lines.length === 0 && parsed.errors.length > 0) {
      throw new BadRequestException({
        message: "Bank return CSV could not be parsed",
        errors: parsed.errors,
        honestyNote: parsed.honestyNote,
      });
    }

    const items = await this.db
      .select({
        id: payrollBankBatchItems.id,
        userId: payrollBankBatchItems.userId,
        status: payrollBankBatchItems.status,
      })
      .from(payrollBankBatchItems)
      .where(
        and(eq(payrollBankBatchItems.batchId, batchId), eq(payrollBankBatchItems.orgId, orgId)),
      );

    const byId = new Map(items.map((i) => [i.id, i]));
    const byUser = new Map<string, typeof items>();
    for (const it of items) {
      const list = byUser.get(it.userId) ?? [];
      list.push(it);
      byUser.set(it.userId, list);
    }

    let paid = 0;
    let failed = 0;
    let skipped = 0;
    const applyErrors: { line: number; message: string }[] = [...parsed.errors];

    for (const line of parsed.lines) {
      let target =
        line.itemId != null ? byId.get(line.itemId) : undefined;
      if (!target && line.userId) {
        const candidates = byUser.get(line.userId) ?? [];
        target =
          candidates.find((c) => c.status !== "PAID" && c.status !== "FAILED") ??
          candidates[0];
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
        await this.markItemPaid(
          orgId,
          batchId,
          target.id,
          line.transactionRef ?? "RETURN",
          actorId,
        );
        paid++;
      } else {
        await this.markItemFailed(
          orgId,
          batchId,
          target.id,
          line.failureReason ?? "Bank return failed",
          actorId,
        );
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

  async getFile(orgId: string, batchId: number) {
    const batch = await this.db.query.payrollBankBatches.findFirst({
      where: and(eq(payrollBankBatches.id, batchId), eq(payrollBankBatches.orgId, orgId)),
      columns: { id: true, fileKey: true, batchNumber: true },
    });
    if (!batch) throw new NotFoundException("Batch not found");
    if (!batch.fileKey || !this.storage.isConfigured()) {
      throw new NotFoundException("File not available for this batch");
    }

    const url = await this.storage.getFileUrl(batch.fileKey, 3600);
    return { url, batchNumber: batch.batchNumber };
  }

  async getBankDetails(orgId: string, employeeUserId: string, actorId: string) {
    await assertOrgMember(this.db, orgId, employeeUserId);

    const user = await this.db.query.users.findFirst({
      where: eq(users.id, employeeUserId),
      columns: { id: true, bankDetails: true, name: true, email: true },
    });
    if (!user) throw new NotFoundException("Employee not found");

    const bank = decryptBankDetails(user.bankDetails ?? null);

    this.audit.log({
      action: "payroll.bank_details_viewed",
      userId: actorId,
      orgId,
      targetId: employeeUserId,
      targetType: "employee",
      metadata: { employeeName: user.name ?? user.email },
    });

    return {
      userId: employeeUserId,
      employeeName: user.name ?? user.email,
      accountNumber: bank?.accountNumber ?? null,
      bankName: bank?.bankName ?? null,
      branch: bank?.branch ?? null,
      ifsc: bank?.ifsc ?? null,
      accountHolder: bank?.accountHolder ?? null,
      pfUanNumber: bank?.pfUanNumber ?? null,
      bankCountry: bank?.bankCountry ?? null,
    };
  }
}

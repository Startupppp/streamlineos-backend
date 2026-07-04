import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
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
import { decryptBankDetails } from "../../../modules/hr-payroll/lib/encryption";
import type { PayoutBatchFormat } from "./dto/payout.schemas";

function defaultFormatFromCurrency(currency: string): PayoutBatchFormat {
  if (currency === "INR") return "NEFT_CSV";
  if (currency === "USD") return "ACH_CSV";
  if (currency === "EUR") return "SEPA_CSV";
  return "GENERIC_CSV";
}

function csvHeader(format: PayoutBatchFormat): string {
  switch (format) {
    case "NEFT_CSV":
    case "RTGS_CSV":
      return "SrNo,EmployeeName,AccountNumber,IFSCCode,Amount,Narration";
    case "ACH_CSV":
      return "SrNo,EmployeeName,RoutingNumber,AccountNumber,Amount,Narration";
    case "SEPA_CSV":
      return "SrNo,EmployeeName,IBAN,BIC,Currency,Amount,Reference";
    case "GENERIC_CSV":
      return "SrNo,EmployeeName,AccountNumber,BankCode,Currency,Amount,Narration";
  }
}

function csvRow(
  format: PayoutBatchFormat,
  idx: number,
  name: string,
  accountNumber: string,
  bankCode: string,
  currency: string,
  amount: string,
  narration: string,
): string {
  const safeName = name.replace(/"/g, "");
  const amt = parseFloat(amount).toFixed(2);
  switch (format) {
    case "NEFT_CSV":
    case "RTGS_CSV":
      return `${idx},"${safeName}","${accountNumber}","${bankCode}",${amt},"${narration}"`;
    case "ACH_CSV":
      return `${idx},"${safeName}","${bankCode}","${accountNumber}",${amt},"${narration}"`;
    case "SEPA_CSV":
      return `${idx},"${safeName}","${accountNumber}","${bankCode}","${currency}",${amt},"${narration}"`;
    case "GENERIC_CSV":
      return `${idx},"${safeName}","${accountNumber}","${bankCode}","${currency}",${amt},"${narration}"`;
  }
}

@Injectable()
export class PayoutBatchesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

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

    if (idempotencyKey) {
      const existing = await this.db.query.payrollBankBatches.findFirst({
        where: and(
          eq(payrollBankBatches.orgId, orgId),
          eq(payrollBankBatches.idempotencyKey, idempotencyKey),
        ),
      });
      if (existing) {
        const items = await this.db.query.payrollBankBatchItems.findMany({
          where: eq(payrollBankBatchItems.batchId, existing.id),
        });
        return { batch: existing, items, replayed: true };
      }
    }

    const employees = await this.db
      .select({
        id: payrollRunEmployees.id,
        userId: payrollRunEmployees.userId,
        net: payrollRunEmployees.net,
        currency: payrollRunEmployees.currency,
        status: payrollRunEmployees.status,
        holdReason: payrollRunEmployees.holdReason,
        bankDetails: users.bankDetails,
        name: users.name,
      })
      .from(payrollRunEmployees)
      .leftJoin(users, eq(payrollRunEmployees.userId, users.id))
      .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId)));

    const eligible = employees.filter(e => {
      if (e.status === "HELD" || e.holdReason) return false;
      const bank = decryptBankDetails(e.bankDetails ?? null);
      if (!bank?.accountNumber) return false;
      const net = parseFloat(e.net);
      if (net <= 0) return false;
      return true;
    });

    if (eligible.length === 0) {
      throw new BadRequestException("No eligible employees for payout batch — check validation");
    }

    const firstCurrency = eligible[0]?.currency ?? "INR";
    const resolvedFormat: PayoutBatchFormat = format ?? defaultFormatFromCurrency(firstCurrency);

    const narrationLabel = `Salary ${run.month ?? ""}`.trim();
    const csvRows = [csvHeader(resolvedFormat)];
    const itemsData: Array<{
      runEmployeeId: number;
      userId: string;
      amount: string;
      accountMasked: string;
      ifsc: string | null;
    }> = [];

    eligible.forEach((emp, idx) => {
      const bank = decryptBankDetails(emp.bankDetails ?? null);
      if (!bank?.accountNumber) return;
      const bankCode = bank.ifsc ?? "";
      csvRows.push(
        csvRow(
          resolvedFormat,
          idx + 1,
          emp.name ?? emp.userId,
          bank.accountNumber,
          bankCode,
          emp.currency,
          emp.net,
          narrationLabel,
        ),
      );
      itemsData.push({
        runEmployeeId: emp.id,
        userId: emp.userId,
        amount: emp.net,
        accountMasked: "XXXX" + bank.accountNumber.slice(-4),
        ifsc: bankCode || null,
      });
    });

    const csvContent = csvRows.join("\n");
    const csvBuffer = Buffer.from(csvContent, "utf-8");
    const month = run.month ?? "unknown";
    const fileName = `payroll-batch-${month}-${Date.now()}.csv`;

    const [uploadResult, seqResult] = await Promise.all([
      this.storage.isConfigured()
        ? this.storage.uploadFile(csvBuffer, "payroll/bank-batches", fileName, "text/csv")
        : Promise.resolve({ url: null as string | null, key: null as string | null }),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(payrollBankBatches)
        .where(and(eq(payrollBankBatches.orgId, orgId), eq(payrollBankBatches.runId, runId))),
    ]);

    const seq = (seqResult[0]?.count ?? 0) + 1;
    const monthNum = month.replace("-", "");
    const batchNumber = `PAY-${monthNum}-${String(seq).padStart(3, "0")}`;
    const totalAmount = itemsData.reduce((s, i) => s + parseFloat(i.amount), 0).toFixed(2);
    const now = new Date();

    const [newBatch] = await this.db.transaction(async (tx) => {
      const [batch] = await tx
        .insert(payrollBankBatches)
        .values({
          orgId,
          runId,
          batchNumber,
          status: "GENERATED",
          format: resolvedFormat,
          totalAmount,
          itemCount: itemsData.length,
          idempotencyKey: idempotencyKey ?? null,
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
          format: resolvedFormat,
          fileKey: uploadResult.key ?? null,
        },
      });

      return [batch];
    });

    this.audit.log({
      action: "payroll.bank_batch_generated",
      userId,
      orgId,
      targetId: String(runId),
      targetType: "payroll_run",
      metadata: { batchId: newBatch.id, batchNumber, itemCount: itemsData.length, totalAmount },
    });

    const items = await this.db.query.payrollBankBatchItems.findMany({
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

    return { batch: newBatch, items, fileUrl, replayed: false };
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
      where: eq(payrollBankBatchItems.batchId, batchId),
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
        .where(eq(payrollBankBatches.id, batchId));

      await tx
        .update(payrollBankBatchItems)
        .set({ status: "SENT" })
        .where(
          and(eq(payrollBankBatchItems.batchId, batchId), eq(payrollBankBatchItems.status, "PENDING")),
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
      where: eq(payrollBankBatches.id, batchId),
      columns: { runId: true },
    });

    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(payrollBankBatchItems)
        .set({ status: "PAID", transactionRef, paidAt: now })
        .where(eq(payrollBankBatchItems.id, itemId));

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

    await this.checkRunCompletion(orgId, batchId, actorId);
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
      where: eq(payrollBankBatches.id, batchId),
      columns: { runId: true },
    });

    await this.db.transaction(async (tx) => {
      await tx
        .update(payrollBankBatchItems)
        .set({ status: "FAILED", failureReason })
        .where(eq(payrollBankBatchItems.id, itemId));

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

    await this.checkRunCompletion(orgId, batchId, actorId);
    return { success: true };
  }

  private async checkRunCompletion(orgId: string, batchId: number, actorId: string) {
    const batch = await this.db.query.payrollBankBatches.findFirst({
      where: eq(payrollBankBatches.id, batchId),
      columns: { runId: true },
    });
    if (!batch) return;

    const runId = batch.runId;

    const allBatches = await this.db
      .select({ id: payrollBankBatches.id })
      .from(payrollBankBatches)
      .where(and(eq(payrollBankBatches.orgId, orgId), eq(payrollBankBatches.runId, runId)));

    const batchIds = allBatches.map(b => b.id);
    if (batchIds.length === 0) return;

    const pendingItems = await this.db
      .select({ id: payrollBankBatchItems.id })
      .from(payrollBankBatchItems)
      .where(
        and(
          inArray(payrollBankBatchItems.batchId, batchIds),
          not(eq(payrollBankBatchItems.status, "PAID")),
          not(eq(payrollBankBatchItems.status, "FAILED")),
          not(eq(payrollBankBatchItems.status, "HELD")),
        ),
      )
      .limit(1);

    if (pendingItems.length > 0) return;

    const paidItemUserIds = await this.db
      .select({ userId: payrollBankBatchItems.userId })
      .from(payrollBankBatchItems)
      .where(
        and(
          inArray(payrollBankBatchItems.batchId, batchIds),
          eq(payrollBankBatchItems.status, "PAID"),
        ),
      );

    const paidUserIds = paidItemUserIds.map(r => r.userId);

    const now = new Date();
    let runMarkedPaid = false;

    await this.db.transaction(async (tx) => {
      const [currentRun] = await tx
        .select({ status: payrollRuns.status })
        .from(payrollRuns)
        .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
        .limit(1);

      if (!currentRun || currentRun.status === "PAID" || currentRun.status === "PAYSLIPS_PUBLISHED" || currentRun.status === "CLOSED") {
        return;
      }

      await tx
        .update(payrollRuns)
        .set({ status: "PAID", paidAt: now, paidBy: actorId })
        .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)));

      if (paidUserIds.length > 0) {
        await tx
          .update(payrollRunEmployees)
          .set({ status: "PAID" })
          .where(
            and(
              eq(payrollRunEmployees.runId, runId),
              eq(payrollRunEmployees.orgId, orgId),
              inArray(payrollRunEmployees.userId, paidUserIds),
            ),
          );
      }

      await tx.insert(payrollRunEvents).values({
        orgId,
        runId,
        type: "MARKED_PAID",
        actorId,
        metadata: { paidCount: paidUserIds.length },
      });

      runMarkedPaid = true;
    });

    if (runMarkedPaid) {
      this.audit.log({
        action: "payroll.marked_paid",
        userId: actorId,
        orgId,
        targetId: String(runId),
        targetType: "payroll_run",
        metadata: { paidCount: paidUserIds.length },
      });
    }
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

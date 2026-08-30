import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import {
  payrollRuns,
  payrollRunEmployees,
  payrollBankBatches,
  payrollBankBatchItems,
  payrollRunEvents,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { StorageService } from "../../storage/storage.service";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import type { PayoutBatchFormat } from "./dto/payout.schemas";
import { loadRunEmployeePayees } from "../lib/payroll-run-payee";
import { defaultFormatFromCurrency, csvHeader, csvRow } from "./lib/payout-csv";
import { toPaise, fromPaise } from "../runs/lib/money";

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

type ItemData = {
  runEmployeeId: number;
  userId: string | null;
  workerId: string | null;
  amount: string;
  accountMasked: string;
  ifsc: string | null;
};

export type BatchCreateResult = {
  batch: typeof payrollBankBatches.$inferSelect;
  items: Array<typeof payrollBankBatchItems.$inferSelect>;
  fileUrl: string | null;
  currencyCode: string;
  replayed: boolean;
};

@Injectable()
export class BatchCreatorService {
  private readonly logger = new Logger(BatchCreatorService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly efService: EmploymentFactsService,
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
    if (!run) throw new BadRequestException("Payroll run not found");
    if (run.status !== "APPROVED" && run.status !== "LOCKED") {
      throw new BadRequestException(
        `Cannot generate payout batch for run in status ${run.status} — run must be APPROVED or LOCKED`,
      );
    }

    const employees = await this.db
      .select({
        id: payrollRunEmployees.id,
        userId: payrollRunEmployees.userId,
        workerId: payrollRunEmployees.workerId,
        net: payrollRunEmployees.net,
        currency: payrollRunEmployees.currency,
        payoutCurrency: payrollRunEmployees.payoutCurrency,
        netPayoutCurrency: payrollRunEmployees.netPayoutCurrency,
        status: payrollRunEmployees.status,
        holdReason: payrollRunEmployees.holdReason,
      })
      .from(payrollRunEmployees)
      .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId)));

    const payees = await loadRunEmployeePayees(this.db, orgId, runId, this.efService);
    const payeeByRunEmployee = new Map(payees.map((payee) => [payee.runEmployeeId, payee]));

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

    const eligible = employees.filter((e) => {
      if (alreadyPaidRunEmployeeIds.has(e.id)) return false;
      if (e.status === "HELD" || e.holdReason) return false;
      const payee = payeeByRunEmployee.get(e.id);
      const bank = payee?.bankDetails ?? null;
      if (!bank?.accountNumber) return false;
      return toPaise(e.netPayoutCurrency ?? e.net) > 0;
    });

    if (eligible.length === 0)
      throw new BadRequestException("No eligible employees for payout batch — check validation");

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

    const results: BatchCreateResult[] = [];
    let groupIdx = 0;

    for (const [currencyCode, groupEmps] of groupMap) {
      const groupFormat: PayoutBatchFormat = format ?? defaultFormatFromCurrency(currencyCode);
      const subKey = idempotencyKey ? `${idempotencyKey}-${currencyCode}` : undefined;

      if (subKey) {
        const existingBatch = await this.db.query.payrollBankBatches.findFirst({
          where: and(eq(payrollBankBatches.orgId, orgId), eq(payrollBankBatches.idempotencyKey, subKey)),
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
        const payee = payeeByRunEmployee.get(emp.id);
        const bank = payee?.bankDetails ?? null;
        if (!bank?.accountNumber) return;
        const bankCode = bank.ifsc ?? "";
        const effectiveAmount = emp.netPayoutCurrency ?? emp.net;
        const payeeName = payee?.displayName ?? emp.userId ?? emp.workerId ?? "Payee";
        csvRows.push(csvRow(groupFormat, idx + 1, payeeName, bank.accountNumber, bankCode, currencyCode, toPaise(effectiveAmount), narrationLabel));
        itemsData.push({
          runEmployeeId: emp.id,
          userId: emp.userId,
          workerId: emp.workerId,
          amount: effectiveAmount,
          accountMasked: "XXXX" + bank.accountNumber.slice(-4),
          ifsc: bankCode || null,
        });
      });

      const csvContent = csvRows.join("\n");
      const csvBuffer = Buffer.from(csvContent, "utf-8");
      const fileName = `payroll-batch-${month}-${currencyCode}-${Date.now()}.csv`;

      const seq = baseSeq + groupIdx + 1;
      const batchNumber = `PAY-${monthNum}-${currencyCode}-${String(seq).padStart(3, "0")}`;
      const totalAmountPaise = itemsData.reduce((s, i) => s + toPaise(i.amount), 0);
      const totalAmount = fromPaise(totalAmountPaise);
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
              fileKey: null,
              generatedBy: userId,
              generatedAt: now,
            })
            .returning();

          if (!batch) throw new BadRequestException("Failed to create batch");

          await tx.insert(payrollBankBatchItems).values(
            itemsData.map((item) => ({
              orgId,
              batchId: batch.id,
              runEmployeeId: item.runEmployeeId,
              userId: item.userId,
              workerId: item.workerId,
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
              fileKey: null,
            },
          });

          return [batch];
        });
        newBatch = created;
      } catch (err: unknown) {
        if (subKey && isDuplicateKeyError(err)) {
          const racedBatch = await this.db.query.payrollBankBatches.findFirst({
            where: and(eq(payrollBankBatches.orgId, orgId), eq(payrollBankBatches.idempotencyKey, subKey)),
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

      if (!newBatch) throw new InternalServerErrorException("Batch creation returned no row");

      this.audit.log({
        action: "payroll.bank_batch_generated",
        userId,
        orgId,
        targetId: String(runId),
        targetType: "payroll_run",
        metadata: { batchId: newBatch.id, batchNumber, itemCount: itemsData.length, totalAmount, currencyCode },
      });

      if (this.storage.isConfigured()) {
        const batchId = newBatch.id;
        const hooked = registerAfterCommit(async () => {
          const uploaded = await this.storage.uploadFile(orgId, csvBuffer, "payroll/bank-batches", fileName, "text/csv");
          await runInNewTenantTransaction(this.db, orgId, async (tx) => {
            await tx
              .update(payrollBankBatches)
              .set({ fileKey: uploaded.key })
              .where(and(eq(payrollBankBatches.id, batchId), eq(payrollBankBatches.orgId, orgId)));
          });
        });
        if (!hooked)
          this.logger.warn("createBatch: no ambient tenant context; CSV upload skipped for batch", { batchId, orgId });
      }

      const batchItems = await this.db.query.payrollBankBatchItems.findMany({
        where: eq(payrollBankBatchItems.batchId, newBatch.id),
      });

      results.push({ batch: newBatch, items: batchItems, fileUrl: null, currencyCode, replayed: false });
      groupIdx++;
    }

    const allReplayed = results.length > 0 && results.every((r) => r.replayed);
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
}

import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import {
  payrollBankBatches,
  payrollBankBatchItems,
  users,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { StorageService } from "../../storage/storage.service";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { assertPayrollPayeeEligible } from "../lib/payroll-payee-eligibility";
import { buildCursorPage, decodeCursor, type CursorPage } from "../../../common/pagination/cursor";

const BATCH_LIST_CAP = 100;

type BatchRow = {
  id: number;
  orgId: string;
  runId: number;
  batchNumber: string;
  status: string;
  format: string;
  totalAmount: string;
  itemCount: number;
  generatedBy: string | null;
  generatedAt: Date | null;
  sentAt: Date | null;
  idempotencyKey: string | null;
};

type BatchItemRow = {
  id: number;
  orgId: string;
  batchId: number;
  userId: string | null;
  workerId: string | null;
  runEmployeeId: number;
  amount: string;
  accountMasked: string;
  ifsc: string | null;
  status: string;
  transactionRef: string | null;
  failureReason: string | null;
  paidAt: Date | null;
};

@Injectable()
export class PayoutBatchesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly efService: EmploymentFactsService,
  ) {}

  async listBatches(
    orgId: string,
    runId?: number,
    cursor?: string,
    limit = 50,
  ): Promise<CursorPage<BatchRow>> {
    const pageLimit = Math.min(limit, BATCH_LIST_CAP);
    const pos = decodeCursor(cursor);

    const baseConditions = runId
      ? [eq(payrollBankBatches.orgId, orgId), eq(payrollBankBatches.runId, runId)]
      : [eq(payrollBankBatches.orgId, orgId)];

    const cursorCondition = pos
      ? or(
          lt(payrollBankBatches.generatedAt, new Date(pos.sortValue)),
          and(
            eq(payrollBankBatches.generatedAt, new Date(pos.sortValue)),
            lt(payrollBankBatches.id, Number(pos.id)),
          ),
        )
      : undefined;

    const conditions = cursorCondition ? [...baseConditions, cursorCondition] : baseConditions;

    const rows = await this.db
      .select({
        id: payrollBankBatches.id,
        orgId: payrollBankBatches.orgId,
        runId: payrollBankBatches.runId,
        batchNumber: payrollBankBatches.batchNumber,
        status: payrollBankBatches.status,
        format: payrollBankBatches.format,
        totalAmount: payrollBankBatches.totalAmount,
        itemCount: payrollBankBatches.itemCount,
        generatedBy: payrollBankBatches.generatedBy,
        generatedAt: payrollBankBatches.generatedAt,
        sentAt: payrollBankBatches.sentAt,
        idempotencyKey: payrollBankBatches.idempotencyKey,
      })
      .from(payrollBankBatches)
      .where(and(...conditions))
      .orderBy(desc(payrollBankBatches.generatedAt), desc(payrollBankBatches.id))
      .limit(pageLimit + 1);

    return buildCursorPage(rows as BatchRow[], pageLimit, (row) => ({
      sortValue: (row.generatedAt ?? new Date(0)).toISOString(),
      id: String(row.id),
    }));
  }

  async getBatch(orgId: string, batchId: number) {
    const batch = await this.db
      .select({
        id: payrollBankBatches.id,
        orgId: payrollBankBatches.orgId,
        runId: payrollBankBatches.runId,
        batchNumber: payrollBankBatches.batchNumber,
        status: payrollBankBatches.status,
        format: payrollBankBatches.format,
        totalAmount: payrollBankBatches.totalAmount,
        itemCount: payrollBankBatches.itemCount,
        generatedBy: payrollBankBatches.generatedBy,
        generatedAt: payrollBankBatches.generatedAt,
        sentAt: payrollBankBatches.sentAt,
        idempotencyKey: payrollBankBatches.idempotencyKey,
      })
      .from(payrollBankBatches)
      .where(and(eq(payrollBankBatches.id, batchId), eq(payrollBankBatches.orgId, orgId)))
      .limit(1);

    if (!batch[0]) throw new NotFoundException("Batch not found");

    const items = await this.db
      .select({
        id: payrollBankBatchItems.id,
        orgId: payrollBankBatchItems.orgId,
        batchId: payrollBankBatchItems.batchId,
        userId: payrollBankBatchItems.userId,
        workerId: payrollBankBatchItems.workerId,
        runEmployeeId: payrollBankBatchItems.runEmployeeId,
        amount: payrollBankBatchItems.amount,
        accountMasked: payrollBankBatchItems.accountMasked,
        ifsc: payrollBankBatchItems.ifsc,
        status: payrollBankBatchItems.status,
        transactionRef: payrollBankBatchItems.transactionRef,
        failureReason: payrollBankBatchItems.failureReason,
        paidAt: payrollBankBatchItems.paidAt,
      })
      .from(payrollBankBatchItems)
      .where(and(eq(payrollBankBatchItems.batchId, batchId), eq(payrollBankBatchItems.orgId, orgId)));

    return { batch: batch[0] as BatchRow, items: items as BatchItemRow[] };
  }

  async getFile(orgId: string, batchId: number) {
    const batch = await this.db
      .select({ id: payrollBankBatches.id, fileKey: payrollBankBatches.fileKey, batchNumber: payrollBankBatches.batchNumber })
      .from(payrollBankBatches)
      .where(and(eq(payrollBankBatches.id, batchId), eq(payrollBankBatches.orgId, orgId)))
      .limit(1);

    if (!batch[0]) throw new NotFoundException("Batch not found");
    if (!batch[0].fileKey || !this.storage.isConfigured())
      throw new NotFoundException("File not available for this batch");

    const url = await this.storage.getFileUrl(orgId, batch[0].fileKey, 3600);
    return { url, batchNumber: batch[0].batchNumber };
  }

  async getBankDetails(orgId: string, employeeUserId: string, actorId: string) {
    await assertPayrollPayeeEligible(this.db, orgId, employeeUserId);

    const [user, sensitive] = await Promise.all([
      this.db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, employeeUserId))
        .limit(1),
      this.efService.getSensitiveFacts(orgId, employeeUserId),
    ]);
    if (!user[0]) throw new NotFoundException("Employee not found");

    const bank = sensitive.bankDetails;

    this.audit.log({
      action: "payroll.bank_details_viewed",
      userId: actorId,
      orgId,
      targetId: employeeUserId,
      targetType: "employee",
      metadata: { employeeName: user[0].name ?? user[0].email },
    });

    return {
      userId: employeeUserId,
      employeeName: user[0].name ?? user[0].email,
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

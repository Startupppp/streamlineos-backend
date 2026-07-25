import { GoneException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { bankTransfers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateBankTransferInput } from "./dto/payroll.schemas";

function generateNeftCsv(transfer: typeof bankTransfers.$inferSelect): string {
  const header = "SrNo,BeneficiaryName,AccountNumber,IFSCCode,Amount,Remarks";
  const rows = transfer.entries.map((e, i) =>
    `${i + 1},"${e.employeeName}","${e.bankAccount}","${e.ifscCode}",${e.amount},"Salary ${transfer.month}"`
  );
  return [header, ...rows].join("\n");
}

/**
 * Legacy bank transfer surface stores unmasked account/IFSC in JSONB with no idempotency.
 * New writes are disabled (Phase 0). Use canonical `/payroll/payout/batches` instead.
 * List / status / file generation remain available as a read-only migration surface.
 */
@Injectable()
export class BankTransfersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string) {
    return this.db
      .select()
      .from(bankTransfers)
      .where(eq(bankTransfers.orgId, orgId))
      .orderBy(desc(bankTransfers.createdAt))
      .limit(50);
  }

  async create(_orgId: string, _userId: string, _data: CreateBankTransferInput): Promise<never> {
    throw new GoneException(
      "Legacy unmasked bank transfer creation is disabled. Use /payroll/runs/:runId/bank-batches (masked, idempotent) instead.",
    );
  }

  async updateStatus(orgId: string, id: number, data: { status: string; referenceNo?: string }) {
    const [item] = await this.db
      .update(bankTransfers)
      .set({
        status: data.status,
        referenceNo: data.referenceNo,
        processedAt: data.status === "COMPLETED" ? new Date() : undefined,
      })
      .where(and(eq(bankTransfers.id, id), eq(bankTransfers.orgId, orgId)))
      .returning();
    if (!item) throw new NotFoundException("Bank transfer not found");
    return item;
  }

  async generateFile(orgId: string, id: number) {
    const [transfer] = await this.db
      .select()
      .from(bankTransfers)
      .where(and(eq(bankTransfers.id, id), eq(bankTransfers.orgId, orgId)));
    if (!transfer) throw new NotFoundException("Bank transfer not found");
    return { format: "NEFT_CSV", data: generateNeftCsv(transfer), month: transfer.month };
  }
}
